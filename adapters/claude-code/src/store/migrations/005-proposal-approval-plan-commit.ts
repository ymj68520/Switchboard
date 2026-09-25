/**
 * Migration 005 — proposal-approval-plan-commit (frozen plan Phase 6 §4/§5).
 *
 * Adds the FIRST authorized committed-memory write path's persistence:
 * working-state Proposals (identity ≠ revision ≠ state), exact-bound
 * Approvals, the linear PlanCommit chain, the append-only audit log, and the
 * plan_heads upgrade from "HEAD snapshot" to the mutually consistent
 * HEAD Commit/Snapshot pair.
 *
 * Database-level guarantees (Application layers add the rest):
 *   - proposal_revisions / approvals / plan_commits / audit_events are
 *     immutable (BEFORE UPDATE/DELETE triggers RAISE(ABORT))
 *   - proposal_states only walks awaiting_approval → approved/rejected/
 *     superseded and every revision starts awaiting_approval (triggers)
 *   - at most ONE awaiting proposal revision per run (partial unique index)
 *   - an Approval row's proposal_hash must equal the frozen revision's hash
 *     (BEFORE INSERT trigger on top of the composite FK)
 *   - one root commit per run, one child per parent, UNIQUE(run_id, sequence)
 *     (partial + plain unique indexes)
 *   - head_commit_id != null requires the commit's resulting_snapshot_id to
 *     equal head_snapshot_id (BEFORE INSERT/UPDATE triggers)
 *
 * Legacy schema-4 snapshot-only HEADs are PRESERVED with head_commit_id =
 * NULL — history is never fabricated into commits (§85). The engine fails
 * closed (MEMORY_HEAD_UNCOMMITTED) when asked to commit on top of one.
 */

import type { StoreTx } from "../transaction.js";
import type { StoreMigration } from "./index.js";

export function createProposalApprovalCommitMigration(): StoreMigration {
  return {
    from: 4,
    to: 5,
    name: "proposal-approval-plan-commit",
    apply(tx: StoreTx): void {
      // -- Proposal working state ------------------------------------------------
      tx.exec(`
        CREATE TABLE proposals (
          run_id TEXT NOT NULL REFERENCES planning_runs(run_id),
          proposal_id TEXT NOT NULL,
          prepare_request_id TEXT,
          prepare_request_input_json TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, proposal_id)
        )
      `);
      tx.exec(`
        CREATE UNIQUE INDEX idx_proposals_request
          ON proposals (prepare_request_id) WHERE prepare_request_id IS NOT NULL
      `);
      tx.exec(`
        CREATE INDEX idx_proposals_proposal_id ON proposals (proposal_id)
      `);

      // -- Frozen proposal revisions (immutable content + hash) -----------------
      tx.exec(`
        CREATE TABLE proposal_revisions (
          run_id TEXT NOT NULL,
          proposal_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          proposal_type TEXT NOT NULL CHECK (proposal_type IN
            ('design_checkpoint','architecture_completion','section_completion','amendment','final_plan')),
          scope_json TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          changes_json TEXT NOT NULL,
          dependencies_json TEXT NOT NULL,
          impact_json TEXT NOT NULL,
          base_run_revision INTEGER NOT NULL CHECK (base_run_revision >= 1),
          base_head_snapshot_id TEXT,
          base_head_commit_id TEXT,
          canonical_json TEXT NOT NULL,
          proposal_hash TEXT NOT NULL CHECK (proposal_hash LIKE 'sha256:%'),
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, proposal_id, revision),
          CHECK ((base_head_snapshot_id IS NULL AND base_head_commit_id IS NULL)
              OR (base_head_snapshot_id IS NOT NULL AND base_head_commit_id IS NOT NULL)),
          FOREIGN KEY (run_id, proposal_id)
            REFERENCES proposals(run_id, proposal_id),
          FOREIGN KEY (run_id, base_head_snapshot_id)
            REFERENCES plan_snapshots(run_id, snapshot_id),
          FOREIGN KEY (run_id, base_head_commit_id)
            REFERENCES plan_commits(run_id, commit_id)
        )
      `);

      // -- Per-revision lifecycle state (mutable, trigger-guarded) --------------
      tx.exec(`
        CREATE TABLE proposal_states (
          run_id TEXT NOT NULL,
          proposal_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('awaiting_approval','approved','rejected','superseded')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (run_id, proposal_id, revision),
          FOREIGN KEY (run_id, proposal_id, revision)
            REFERENCES proposal_revisions(run_id, proposal_id, revision)
        )
      `);
      tx.exec(`
        CREATE UNIQUE INDEX idx_proposal_states_one_awaiting
          ON proposal_states (run_id) WHERE status = 'awaiting_approval'
      `);

      // -- Immutable approvals bound to the exact frozen revision ---------------
      tx.exec(`
        CREATE TABLE approvals (
          approval_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          proposal_id TEXT NOT NULL,
          proposal_revision INTEGER NOT NULL,
          proposal_hash TEXT NOT NULL,
          actor TEXT NOT NULL CHECK (actor = 'user'),
          authorization_request_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (run_id, proposal_id, proposal_revision)
            REFERENCES proposal_revisions(run_id, proposal_id, revision)
        )
      `);
      tx.exec(`
        CREATE UNIQUE INDEX idx_approvals_request
          ON approvals (authorization_request_id)
      `);
      tx.exec(`
        CREATE UNIQUE INDEX idx_approvals_proposal_revision
          ON approvals (run_id, proposal_id, proposal_revision)
      `);

      // -- Linear PlanCommit chain ----------------------------------------------
      tx.exec(`
        CREATE TABLE plan_commits (
          commit_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES planning_runs(run_id),
          sequence INTEGER NOT NULL CHECK (sequence >= 1),
          proposal_id TEXT NOT NULL,
          proposal_revision INTEGER NOT NULL,
          approval_id TEXT NOT NULL,
          parent_commit_id TEXT,
          base_snapshot_id TEXT,
          resulting_snapshot_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          CHECK ((parent_commit_id IS NULL AND base_snapshot_id IS NULL)
              OR (parent_commit_id IS NOT NULL AND base_snapshot_id IS NOT NULL)),
          FOREIGN KEY (run_id, proposal_id, proposal_revision)
            REFERENCES proposal_revisions(run_id, proposal_id, revision),
          FOREIGN KEY (approval_id) REFERENCES approvals(approval_id),
          FOREIGN KEY (run_id, parent_commit_id)
            REFERENCES plan_commits(run_id, commit_id),
          FOREIGN KEY (run_id, base_snapshot_id)
            REFERENCES plan_snapshots(run_id, snapshot_id),
          FOREIGN KEY (run_id, resulting_snapshot_id)
            REFERENCES plan_snapshots(run_id, snapshot_id)
        )
      `);
      tx.exec(`
        CREATE UNIQUE INDEX idx_plan_commits_run_sequence
          ON plan_commits (run_id, sequence)
      `);
      tx.exec(`
        CREATE UNIQUE INDEX idx_plan_commits_one_root
          ON plan_commits (run_id) WHERE parent_commit_id IS NULL
      `);
      tx.exec(`
        CREATE UNIQUE INDEX idx_plan_commits_one_child
          ON plan_commits (parent_commit_id) WHERE parent_commit_id IS NOT NULL
      `);
      tx.exec(`
        CREATE UNIQUE INDEX idx_plan_commits_run_commit
          ON plan_commits (run_id, commit_id)
      `);
      tx.exec(`
        CREATE UNIQUE INDEX idx_plan_commits_approval
          ON plan_commits (approval_id)
      `);

      // -- Append-only audit event log ------------------------------------------
      tx.exec(`
        CREATE TABLE audit_events (
          event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          run_id TEXT NOT NULL REFERENCES planning_runs(run_id),
          event_type TEXT NOT NULL CHECK (event_type IN
            ('PROPOSAL_PREPARED','PROPOSAL_REVISED','PROPOSAL_REJECTED','PLAN_COMMITTED')),
          subject_json TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);

      // -- plan_heads upgrade: HEAD = Commit/Snapshot pair ----------------------
      // Legacy snapshot-only heads are preserved with head_commit_id NULL.
      tx.exec("ALTER TABLE plan_heads RENAME TO plan_heads_v4_legacy");
      tx.exec(`
        CREATE TABLE plan_heads (
          run_id TEXT PRIMARY KEY REFERENCES planning_runs(run_id),
          head_snapshot_id TEXT NOT NULL,
          head_commit_id TEXT,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (run_id, head_snapshot_id)
            REFERENCES plan_snapshots(run_id, snapshot_id),
          FOREIGN KEY (run_id, head_commit_id)
            REFERENCES plan_commits(run_id, commit_id)
        )
      `);
      tx.exec(`
        INSERT INTO plan_heads (run_id, head_snapshot_id, head_commit_id, updated_at)
          SELECT run_id, head_snapshot_id, NULL, updated_at FROM plan_heads_v4_legacy
      `);
      tx.exec("DROP TABLE plan_heads_v4_legacy");

      // -- Triggers --------------------------------------------------------------
      const immutableTables = ["proposal_revisions", "approvals", "plan_commits", "audit_events"];
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
        CREATE TRIGGER proposal_states_insert_awaiting BEFORE INSERT ON proposal_states
        BEGIN
          SELECT CASE
            WHEN NEW.status != 'awaiting_approval'
              THEN RAISE(ABORT, 'proposal_states: revisions start awaiting_approval')
          END;
        END
      `);
      tx.exec(`
        CREATE TRIGGER proposal_states_transition_guard BEFORE UPDATE ON proposal_states
        BEGIN
          SELECT CASE
            WHEN OLD.status != 'awaiting_approval'
              THEN RAISE(ABORT, 'proposal_states: terminal status is immutable')
            WHEN NEW.status NOT IN ('approved','rejected','superseded')
              THEN RAISE(ABORT, 'proposal_states: illegal status transition')
            WHEN NEW.revision != OLD.revision OR NEW.run_id != OLD.run_id OR NEW.proposal_id != OLD.proposal_id
              THEN RAISE(ABORT, 'proposal_states: identity columns are immutable')
          END;
        END
      `);
      tx.exec(`
        CREATE TRIGGER approvals_hash_match BEFORE INSERT ON approvals
        BEGIN
          SELECT CASE
            WHEN NEW.proposal_hash != (
              SELECT proposal_hash FROM proposal_revisions
              WHERE run_id = NEW.run_id AND proposal_id = NEW.proposal_id AND revision = NEW.proposal_revision
            )
              THEN RAISE(ABORT, 'approvals: proposal_hash does not match the frozen proposal revision')
          END;
        END
      `);
      tx.exec(`
        CREATE TRIGGER plan_heads_commit_pair_insert BEFORE INSERT ON plan_heads
        BEGIN
          SELECT CASE
            WHEN NEW.head_commit_id IS NOT NULL AND (
              SELECT resulting_snapshot_id FROM plan_commits
              WHERE run_id = NEW.run_id AND commit_id = NEW.head_commit_id
            ) != NEW.head_snapshot_id
              THEN RAISE(ABORT, 'plan_heads: head commit does not produce the head snapshot')
          END;
        END
      `);
      tx.exec(`
        CREATE TRIGGER plan_heads_commit_pair_update BEFORE UPDATE ON plan_heads
        BEGIN
          SELECT CASE
            WHEN NEW.head_commit_id IS NOT NULL AND (
              SELECT resulting_snapshot_id FROM plan_commits
              WHERE run_id = NEW.run_id AND commit_id = NEW.head_commit_id
            ) != NEW.head_snapshot_id
              THEN RAISE(ABORT, 'plan_heads: head commit does not produce the head snapshot')
          END;
        END
      `);
    },
  };
}
