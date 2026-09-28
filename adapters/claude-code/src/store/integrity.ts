/**
 * Backup integrity validation (frozen plan §21). A backup only counts as a
 * recovery artifact once it can be opened read-only, passes
 * PRAGMA integrity_check, and exposes the expected schema version.
 */

import { openDatabase, type StoreConnection } from "./connection.js";
import { storeError } from "./errors.js";

/** Run PRAGMA integrity_check on an open connection; must return 'ok'. */
export function integrityCheck(db: StoreConnection): string {
  const row = db.prepare("PRAGMA integrity_check").get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : undefined;
  return typeof value === "string" ? value : "unknown";
}

export interface BackupValidation {
  schemaVersion: number;
  integrity: string;
}

/**
 * Validate a backup file: opens it (header probe included), checks
 * integrity, and verifies the recorded schema version matches the source
 * state that was backed up. The connection is read-write on purpose: it is
 * our own unpublished artifact, and a clean read-write close folds/removes
 * any SQLite WAL sidecars so the published backup stays ONE self-contained
 * file (a read-only open would create -shm/-wal litter around the pending
 * copy). Throws STORE_BACKUP_FAILED on any violation — the caller must then
 * refuse to migrate.
 */
export function validateBackupDatabase(
  backupPath: string,
  expectedSchemaVersion: number,
  options: { busyTimeoutMs?: number } = {},
): BackupValidation {
  let db: StoreConnection;
  try {
    db = openDatabase(backupPath, { busyTimeoutMs: options.busyTimeoutMs });
  } catch (err) {
    throw storeError("STORE_BACKUP_FAILED", `backup file cannot be opened: ${backupPath}`, {
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    const integrity = integrityCheck(db);
    const versionRow = db.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
    const version = versionRow ? Object.values(versionRow)[0] : undefined;
    if (integrity !== "ok") {
      throw storeError("STORE_BACKUP_FAILED", `backup failed integrity_check: ${backupPath}`, {
        cause: `integrity_check returned ${integrity}`,
      });
    }
    if (typeof version !== "number" || version !== expectedSchemaVersion) {
      throw storeError("STORE_BACKUP_FAILED", `backup schema version mismatch: ${backupPath}`, {
        cause: `expected ${expectedSchemaVersion}, found ${String(version)}`,
      });
    }
    return { schemaVersion: version, integrity };
  } finally {
    try {
      db.close();
    } catch {
      // best-effort close on the failure path
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 17 §41 — bounded live-store consistency audit (diagnostic; read-only)
// ---------------------------------------------------------------------------

/**
 * Minimal structural view the audit needs — satisfied by an open StoreTx,
 * a StoreConnection, or node:sqlite's DatabaseSync (the live audit runs it
 * read-only against the production store).
 */
export interface AuditConnection {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export interface StoreConsistencyAudit {
  ok: boolean;
  problems: string[];
  checks: Record<string, boolean>;
}


/**
 * Bounded structural consistency audit over a v13 store (directive §41/E42–
 * E44): integrity + FK pragmas, immutability trigger presence, commit-chain
 * and HEAD-pair consistency, planning/execution binding uniqueness, run-
 * control lineage reachability, handoff provenance, and the Phase 15
 * baseline⟺materialization coherence. NOT a full event replay — each check
 * is a bounded query. Read-only: the caller must hold no write intent.
 */
interface SingleRow {
  [key: string]: unknown;
}

export function auditStoreConsistency(db: AuditConnection): StoreConsistencyAudit {
  const problems: string[] = [];
  const checks: Record<string, boolean> = {};

  const integrity = integrityCheck(db as StoreConnection);
  checks.integrityCheck = integrity === "ok";
  if (!checks.integrityCheck) problems.push(`integrity_check=${integrity}`);

  const fk = db.prepare("PRAGMA foreign_key_check").all() as unknown[];
  checks.foreignKeyCheck = fk.length === 0;
  if (!checks.foreignKeyCheck) problems.push(`foreign_key_check rows=${fk.length}`);

  const triggers = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<SingleRow>).map(
      (r) => String(r.name),
    ),
  );
  const requiredTriggers = [
    "approvals_no_update", "approvals_no_delete", "plan_commits_no_update", "plan_commits_no_delete",
    "run_control_authorizations_no_update", "run_control_authorizations_no_delete",
    "execution_issues_no_update", "planning_run_baselines_no_update", "planning_run_baselines_no_delete",
    "planning_run_baseline_materializations_no_update",
  ];
  const missingTriggers = requiredTriggers.filter((t) => !triggers.has(t));
  checks.immutableTriggers = missingTriggers.length === 0;
  if (!checks.immutableTriggers) problems.push(`missing triggers: ${missingTriggers.join(",")}`);

  // Commit chain: contiguous sequences, parent links chained, first commit parentless.
  const runs = db.prepare("SELECT run_id FROM planning_runs ORDER BY run_id").all() as Array<SingleRow>;
  let chainOk = true;
  let headOk = true;
  for (const { run_id: runId } of runs) {
    const commits = db
      .prepare("SELECT commit_id, sequence, parent_commit_id, resulting_snapshot_id FROM plan_commits WHERE run_id = ? ORDER BY sequence")
      .all(runId) as Array<SingleRow>;
    let prev: SingleRow | null = null;
    for (let i = 0; i < commits.length; i += 1) {
      const c = commits[i]!;
      if (c.sequence !== i + 1) { chainOk = false; problems.push(`commit sequence gap run=${String(runId)} seq=${String(c.sequence)}`); }
      const expectedParent = prev === null ? null : prev.commit_id;
      if (c.parent_commit_id !== expectedParent) { chainOk = false; problems.push(`commit parent mismatch run=${String(runId)} seq=${String(c.sequence)}`); }
      prev = c;
    }
    const head = db.prepare("SELECT head_snapshot_id, head_commit_id FROM plan_heads WHERE run_id = ?").get(runId) as SingleRow | undefined;
    if (head !== undefined) {
      const last = prev;
      if (head.head_commit_id !== null) {
        if (last === null || head.head_commit_id !== last.commit_id || head.head_snapshot_id !== last.resulting_snapshot_id) {
          headOk = false; problems.push(`HEAD pair mismatch run=${String(runId)}`);
        }
      }
    }
  }
  checks.commitChain = chainOk;
  checks.headPair = headOk;

  // Planning binding uniqueness: ≤1 attached per run; a session holds at most
  // one attached binding on an ACTIVE run.
  const dupAttached = db
    .prepare("SELECT run_id, COUNT(*) AS c FROM session_bindings WHERE state = 'attached' GROUP BY run_id HAVING c > 1")
    .all() as unknown[];
  checks.planningBindingUnique = dupAttached.length === 0;
  if (!checks.planningBindingUnique) problems.push(`multiple attached planning bindings on one run: ${dupAttached.length}`);
  const multiActive = db
    .prepare(
      "SELECT b.session_id AS s, COUNT(*) AS c FROM session_bindings b JOIN planning_runs r ON r.run_id = b.run_id "
      + "WHERE b.state = 'attached' AND r.lifecycle = 'active' GROUP BY b.session_id HAVING c > 1",
    )
    .all() as unknown[];
  checks.planningSessionUnique = multiActive.length === 0;
  if (!checks.planningSessionUnique) problems.push(`session with multiple attached active planning runs: ${multiActive.length}`);

  // Execution binding uniqueness: one row per run, at most one attached.
  const dupExec = db
    .prepare("SELECT run_id, COUNT(*) AS c FROM execution_bindings GROUP BY run_id HAVING c > 1")
    .all() as unknown[];
  checks.executionBindingUnique = dupExec.length === 0;
  if (!checks.executionBindingUnique) problems.push(`multiple execution binding rows on one run: ${dupExec.length}`);

  // Run-control lineage: resulting binding generation = expected + 1 and the
  // resulting run revision is one the run actually reached.
  const badLineage = db
    .prepare(
      "SELECT c.control_id, c.run_id FROM run_control_authorizations c "
      + "WHERE c.resulting_binding_generation != c.expected_binding_generation + 1 "
      + "OR c.resulting_run_revision > (SELECT r.revision FROM planning_runs r WHERE r.run_id = c.run_id)",
    )
    .all() as unknown[];
  checks.runControlLineage = badLineage.length === 0;
  if (!checks.runControlLineage) problems.push(`run-control lineage violations: ${badLineage.length}`);

  // Handoff provenance: a DELIVERED handoff implies its run is completed.
  const badDelivery = db
    .prepare(
      "SELECT h.run_id FROM execution_handoffs h JOIN execution_handoff_states s ON s.run_id = h.run_id "
      + "JOIN planning_runs r ON r.run_id = h.run_id WHERE s.status = 'delivered' AND r.lifecycle != 'completed'",
    )
    .all() as unknown[];
  checks.handoffProvenance = badDelivery.length === 0;
  if (!checks.handoffProvenance) problems.push(`delivered handoff on non-completed run: ${badDelivery.length}`);

  // Phase 15 coherence: a baseline is materialized ⟺ its successor has a
  // HEAD commit.
  const baselines = db
    .prepare(
      "SELECT b.baseline_id AS id, b.successor_run_id AS sid, "
      + "(SELECT COUNT(*) FROM planning_run_baseline_materializations m WHERE m.baseline_id = b.baseline_id) AS m "
      + "FROM planning_run_baselines b",
    )
    .all() as Array<SingleRow>;
  let baselineOk = true;
  for (const b of baselines) {
    const headRow = db.prepare("SELECT head_commit_id FROM plan_heads WHERE run_id = ?").get(b.sid) as SingleRow | undefined;
    const headCommit = headRow === undefined ? null : headRow.head_commit_id;
    if ((Number(b.m) > 0) !== (headCommit !== null && headCommit !== undefined)) {
      baselineOk = false;
      problems.push(`baseline materialization⟺HEAD incoherent baseline=${String(b.id)}`);
    }
  }
  checks.baselineCoherence = baselineOk;

  return { ok: problems.length === 0, problems, checks };
}

/**
 * Phase 17 §42 — blob CAS sampling audit: verify hash-path == content hash
 * for a deterministic sample of observation blobs. Returns the sampled and
 * failed counts; `readBytes` fails closed on missing/corrupt blobs, which
 * surfaces here as failures with the blob hash named.
 */
export function auditObservationBlobs(
  rows: Array<{ blob_hash: string }>,
  readBlob: (hash: string) => void,
  sampleSize = 25,
): { sampled: number; failures: string[] } {
  const failures: string[] = [];
  const step = Math.max(1, Math.floor(rows.length / sampleSize));
  let sampled = 0;
  for (let i = 0; i < rows.length && sampled < sampleSize; i += step) {
    const hash = rows[i]!.blob_hash;
    sampled += 1;
    try {
      readBlob(hash);
    } catch (err) {
      failures.push(`${hash}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
  }
  return { sampled, failures };
}
