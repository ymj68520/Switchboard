/**
 * Migration 004 — plan-memory-foundation (frozen plan §4/§5).
 *
 * Adds the committed Plan Memory infrastructure: generic artifact identity +
 * immutable typed revisions (with stable projections), immutable snapshots
 * with exact-revision membership, and the per-run HEAD pointer.
 *
 * SQLite-level immutability: BEFORE UPDATE/DELETE triggers on
 * memory_artifacts, memory_revisions, plan_snapshots, and snapshot_members
 * RAISE(ABORT) — history can never be rewritten through ANY connection.
 * plan_heads is deliberately mutable: it is a materialized pointer, and the
 * future PlanCommit transaction engine is its only legitimate production
 * mover.
 *
 * No Proposal/Approval/PlanCommit tables exist — those belong to Phase 6.
 */

import type { StoreTx } from "../transaction.js";
import type { StoreMigration } from "./index.js";

export function createPlanMemoryMigration(): StoreMigration {
  return {
    from: 3,
    to: 4,
    name: "plan-memory-foundation",
    apply(tx: StoreTx): void {
      tx.exec(`
        CREATE TABLE memory_artifacts (
          run_id TEXT NOT NULL REFERENCES planning_runs(run_id),
          kind TEXT NOT NULL CHECK (kind IN ('constraint','decision','architecture','section','open_question','conflict')),
          artifact_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, kind, artifact_id)
        )
      `);
      tx.exec(`
        CREATE TABLE memory_revisions (
          run_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          artifact_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          content_json TEXT NOT NULL,
          compact_projection TEXT NOT NULL,
          full_projection TEXT,
          contract_json TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, kind, artifact_id, revision),
          FOREIGN KEY (run_id, kind, artifact_id)
            REFERENCES memory_artifacts(run_id, kind, artifact_id)
        )
      `);
      tx.exec(`
        CREATE TABLE plan_snapshots (
          snapshot_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES planning_runs(run_id),
          created_at TEXT NOT NULL,
          UNIQUE (snapshot_id, run_id),
          UNIQUE (run_id, snapshot_id)
        )
      `);
      tx.exec(`
        CREATE TABLE snapshot_members (
          snapshot_id TEXT NOT NULL REFERENCES plan_snapshots(snapshot_id),
          run_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          artifact_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          PRIMARY KEY (snapshot_id, kind, artifact_id),
          FOREIGN KEY (snapshot_id, run_id)
            REFERENCES plan_snapshots(snapshot_id, run_id),
          FOREIGN KEY (run_id, kind, artifact_id, revision)
            REFERENCES memory_revisions(run_id, kind, artifact_id, revision)
        )
      `);
      tx.exec(`
        CREATE TABLE plan_heads (
          run_id TEXT PRIMARY KEY REFERENCES planning_runs(run_id),
          head_snapshot_id TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (run_id, head_snapshot_id)
            REFERENCES plan_snapshots(run_id, snapshot_id)
        )
      `);
      tx.exec(`
        CREATE INDEX idx_memory_revisions_artifact
          ON memory_revisions (run_id, kind, artifact_id, revision)
      `);
      tx.exec(`
        CREATE INDEX idx_snapshot_members_run
          ON snapshot_members (run_id, kind, artifact_id, revision)
      `);

      // Immutability triggers — the database itself refuses history rewrites.
      for (const table of ["memory_artifacts", "memory_revisions", "plan_snapshots", "snapshot_members"]) {
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
