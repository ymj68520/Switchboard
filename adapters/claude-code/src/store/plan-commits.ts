/**
 * Approval / PlanCommit / HEAD / audit persistence (frozen plan Phase 6
 * §30–§39/§60–§71/§73/§76).
 *
 * Approvals and PlanCommits are immutable database rows bound to the exact
 * frozen proposal revision (composite FK + hash-match trigger). The commit
 * chain is linear by construction: one root per run, one child per parent,
 * UNIQUE(run_id, sequence) — with the authoritative protection coming from
 * HEAD compare-and-move inside the engine's single write transaction.
 *
 * plan_heads holds the mutually consistent HEAD pair: head_commit_id != null
 * requires the commit's resulting_snapshot_id to equal head_snapshot_id
 * (pair triggers). A snapshot-only head (legacy Phase 5 shape) is legal DATA
 * but never a legal commit base — the engine fails closed on it.
 */

import { RuntimeError } from "../runtime/errors.js";
import { storeError } from "./errors.js";
import type { PlanStore } from "./sqlite-store.js";
import type { StoreClock } from "./migration-runner.js";
import type { StoreTx } from "./transaction.js";

export type CommitTx = StoreTx;

export interface ApprovalView {
  approvalId: string;
  runId: string;
  proposalId: string;
  proposalRevision: number;
  proposalHash: string;
  actor: "user";
  authorizationRequestId: string;
  createdAt: string;
}

export interface PlanCommitView {
  commitId: string;
  runId: string;
  sequence: number;
  proposalId: string;
  proposalRevision: number;
  approvalId: string;
  parentCommitId: string | null;
  baseSnapshotId: string | null;
  resultingSnapshotId: string;
  createdAt: string;
}

export interface AuditEventView {
  eventSeq: number;
  eventId: string;
  runId: string;
  eventType: string;
  subject: unknown;
  payload: unknown;
  createdAt: string;
}

export type AuditEventType = "PROPOSAL_PREPARED" | "PROPOSAL_REVISED" | "PROPOSAL_REJECTED" | "PLAN_COMMITTED";

interface ApprovalRow {
  approvalId: string;
  runId: string;
  proposalId: string;
  proposalRevision: number;
  proposalHash: string;
  actor: string;
  authorizationRequestId: string;
  createdAt: string;
}

const APPROVAL_COLUMNS =
  "approval_id AS approvalId, run_id AS runId, proposal_id AS proposalId, proposal_revision AS proposalRevision, proposal_hash AS proposalHash, actor, authorization_request_id AS authorizationRequestId, created_at AS createdAt";

interface CommitRow {
  commitId: string;
  runId: string;
  sequence: number;
  proposalId: string;
  proposalRevision: number;
  approvalId: string;
  parentCommitId: string | null;
  baseSnapshotId: string | null;
  resultingSnapshotId: string;
  createdAt: string;
}

const COMMIT_COLUMNS =
  "commit_id AS commitId, run_id AS runId, sequence, proposal_id AS proposalId, proposal_revision AS proposalRevision, approval_id AS approvalId, parent_commit_id AS parentCommitId, base_snapshot_id AS baseSnapshotId, resulting_snapshot_id AS resultingSnapshotId, created_at AS createdAt";

function parseCommitRow(row: CommitRow): PlanCommitView {
  const problems: string[] = [];
  if (typeof row.commitId !== "string" || row.commitId === "") problems.push("commit_id");
  if (typeof row.sequence !== "number" || row.sequence < 1) problems.push("sequence");
  if (typeof row.resultingSnapshotId !== "string" || row.resultingSnapshotId === "") problems.push("resulting_snapshot_id");
  if ((row.parentCommitId === null) !== (row.baseSnapshotId === null)) problems.push("parent/base pairing");
  if (problems.length > 0) {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "plan_commits row is corrupt", {
      detail: { fields: problems, commitId: row.commitId },
    });
  }
  return { ...row, parentCommitId: row.parentCommitId, baseSnapshotId: row.baseSnapshotId };
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/**
 * Persist the user approval. The composite FK pins the exact proposal
 * revision and the hash-match trigger refuses a hash that does not equal
 * the frozen revision's hash; `actor` is hardcoded 'user' at the database.
 */
export function insertApprovalInTx(
  tx: CommitTx,
  input: {
    approvalId: string;
    runId: string;
    proposalId: string;
    proposalRevision: number;
    proposalHash: string;
    authorizationRequestId: string;
  },
  now: string,
): ApprovalView {
  tx.prepare(
    "INSERT INTO approvals (approval_id, run_id, proposal_id, proposal_revision, proposal_hash, actor, authorization_request_id, created_at) VALUES (?, ?, ?, ?, ?, 'user', ?, ?)",
  ).run(
    input.approvalId,
    input.runId,
    input.proposalId,
    input.proposalRevision,
    input.proposalHash,
    input.authorizationRequestId,
    now,
  );
  return {
    approvalId: input.approvalId,
    runId: input.runId,
    proposalId: input.proposalId,
    proposalRevision: input.proposalRevision,
    proposalHash: input.proposalHash,
    actor: "user",
    authorizationRequestId: input.authorizationRequestId,
    createdAt: now,
  };
}

export function findApprovalByRequestInTx(tx: CommitTx, authorizationRequestId: string): ApprovalView | null {
  const row = tx
    .prepare(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE authorization_request_id = ?`)
    .get(authorizationRequestId) as ApprovalRow | undefined;
  return row === undefined ? null : { ...row, actor: "user" as const };
}

export function getApprovalInTx(tx: CommitTx, approvalId: string): ApprovalView | null {
  const row = tx.prepare(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE approval_id = ?`).get(approvalId) as
    | ApprovalRow
    | undefined;
  return row === undefined ? null : { ...row, actor: "user" as const };
}

// ---------------------------------------------------------------------------
// PlanCommit chain
// ---------------------------------------------------------------------------

export function getPlanCommitInTx(tx: CommitTx, commitId: string): PlanCommitView | null {
  const row = tx.prepare(`SELECT ${COMMIT_COLUMNS} FROM plan_commits WHERE commit_id = ?`).get(commitId) as
    | CommitRow
    | undefined;
  return row === undefined ? null : parseCommitRow(row);
}

/** Next linear sequence: parent's sequence + 1, or the root's 1. */
export function nextCommitSequenceInTx(tx: CommitTx, parentCommitId: string | null): number {
  if (parentCommitId === null) return 1;
  const parent = getPlanCommitInTx(tx, parentCommitId);
  if (parent === null) {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "parent commit does not exist", {
      detail: { parentCommitId },
    });
  }
  return parent.sequence + 1;
}

/**
 * Insert the immutable commit row. Unique-index violations (sequence/root/
 * child races) surface as PLAN_COMMIT_CONFLICT — a domain conflict, never a
 * raw SQL error leaking upward.
 */
export function insertPlanCommitInTx(
  tx: CommitTx,
  input: {
    commitId: string;
    runId: string;
    sequence: number;
    proposalId: string;
    proposalRevision: number;
    approvalId: string;
    parentCommitId: string | null;
    baseSnapshotId: string | null;
    resultingSnapshotId: string;
  },
  now: string,
): PlanCommitView {
  try {
    tx.prepare(
      `INSERT INTO plan_commits
        (commit_id, run_id, sequence, proposal_id, proposal_revision, approval_id, parent_commit_id, base_snapshot_id, resulting_snapshot_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.commitId,
      input.runId,
      input.sequence,
      input.proposalId,
      input.proposalRevision,
      input.approvalId,
      input.parentCommitId,
      input.baseSnapshotId,
      input.resultingSnapshotId,
      now,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("UNIQUE constraint failed") || message.includes("CHECK constraint failed")) {
      throw new RuntimeError("PLAN_COMMIT_CONFLICT", "plan commit violates the linear-history constraints", {
        cause: message,
        detail: { runId: input.runId, sequence: input.sequence },
      });
    }
    throw err;
  }
  return {
    commitId: input.commitId,
    runId: input.runId,
    sequence: input.sequence,
    proposalId: input.proposalId,
    proposalRevision: input.proposalRevision,
    approvalId: input.approvalId,
    parentCommitId: input.parentCommitId,
    baseSnapshotId: input.baseSnapshotId,
    resultingSnapshotId: input.resultingSnapshotId,
    createdAt: now,
  };
}

// ---------------------------------------------------------------------------
// HEAD pair
// ---------------------------------------------------------------------------

export interface HeadPair {
  headSnapshotId: string;
  headCommitId: string | null;
}

export function getHeadPairInTx(tx: CommitTx, runId: string): HeadPair | null {
  const row = tx
    .prepare("SELECT head_snapshot_id AS headSnapshotId, head_commit_id AS headCommitId FROM plan_heads WHERE run_id = ?")
    .get(runId) as HeadPair | undefined;
  return row === undefined ? null : row;
}

/**
 * Atomically move HEAD to the new Commit/Snapshot pair. The pair triggers
 * enforce resulting_snapshot_id consistency; this primitive is the ONLY
 * sanctioned way the engine moves a commit-carrying HEAD.
 */
export function setHeadPairInTx(
  tx: CommitTx,
  input: { runId: string; headSnapshotId: string; headCommitId: string },
  clock: StoreClock,
): HeadPair {
  const current = getHeadPairInTx(tx, input.runId);
  if (current === null) {
    tx.prepare(
      "INSERT INTO plan_heads (run_id, head_snapshot_id, head_commit_id, updated_at) VALUES (?, ?, ?, ?)",
    ).run(input.runId, input.headSnapshotId, input.headCommitId, clock.nowIso());
  } else {
    tx.prepare(
      "UPDATE plan_heads SET head_snapshot_id = ?, head_commit_id = ?, updated_at = ? WHERE run_id = ?",
    ).run(input.headSnapshotId, input.headCommitId, clock.nowIso(), input.runId);
  }
  return { headSnapshotId: input.headSnapshotId, headCommitId: input.headCommitId };
}

// ---------------------------------------------------------------------------
// Audit events (append-only; provenance, not authority, §70)
// ---------------------------------------------------------------------------

export function appendAuditEventInTx(
  tx: CommitTx,
  input: {
    eventId: string;
    runId: string;
    eventType: AuditEventType;
    subject: unknown;
    payload: unknown;
  },
  now: string,
): void {
  tx.prepare(
    "INSERT INTO audit_events (event_id, run_id, event_type, subject_json, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(input.eventId, input.runId, input.eventType, JSON.stringify(input.subject), JSON.stringify(input.payload), now);
}

export function listAuditEventsRecord(store: PlanStore, runId: string): AuditEventView[] {
  return store.withRead((tx) => {
    const rows = tx
      .prepare(
        "SELECT event_seq AS eventSeq, event_id AS eventId, run_id AS runId, event_type AS eventType, subject_json AS subjectJson, payload_json AS payloadJson, created_at AS createdAt FROM audit_events WHERE run_id = ? ORDER BY event_seq ASC",
      )
      .all(runId) as {
      eventSeq: number;
      eventId: string;
      runId: string;
      eventType: string;
      subjectJson: string;
      payloadJson: string;
      createdAt: string;
    }[];
    return rows.map((row) => {
      let subject: unknown;
      let payload: unknown;
      try {
        subject = JSON.parse(row.subjectJson);
        payload = JSON.parse(row.payloadJson);
      } catch (err) {
        throw storeError("STORE_SCHEMA_INVALID", "audit event JSON is corrupt", {
          cause: err instanceof Error ? err.message : String(err),
          detail: { eventId: row.eventId },
        });
      }
      return {
        eventSeq: row.eventSeq,
        eventId: row.eventId,
        runId: row.runId,
        eventType: row.eventType,
        subject,
        payload,
        createdAt: row.createdAt,
      };
    });
  });
}

// ---------------------------------------------------------------------------
// Read model (§67/§68)
// ---------------------------------------------------------------------------

export function getApprovalRecord(store: PlanStore, approvalId: string): ApprovalView | null {
  return store.withRead((tx) => getApprovalInTx(tx, approvalId));
}

export function getApprovalForProposalRecord(
  store: PlanStore,
  input: { runId: string; proposalId: string; proposalRevision: number },
): ApprovalView | null {
  return store.withRead((tx) => {
    const row = tx
      .prepare(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE run_id = ? AND proposal_id = ? AND proposal_revision = ?`)
      .get(input.runId, input.proposalId, input.proposalRevision) as ApprovalRow | undefined;
    return row === undefined ? null : { ...row, actor: "user" as const };
  });
}

export function getPlanCommitRecord(store: PlanStore, commitId: string): PlanCommitView | null {
  return store.withRead((tx) => getPlanCommitInTx(tx, commitId));
}

export function getHeadCommitRecord(store: PlanStore, runId: string): PlanCommitView | null {
  return store.withRead((tx) => {
    const head = getHeadPairInTx(tx, runId);
    if (head === null || head.headCommitId === null) return null;
    return getPlanCommitInTx(tx, head.headCommitId);
  });
}

export function listPlanCommitsRecord(store: PlanStore, runId: string): PlanCommitView[] {
  return store.withRead((tx) => {
    const rows = tx
      .prepare(`SELECT ${COMMIT_COLUMNS} FROM plan_commits WHERE run_id = ? ORDER BY sequence ASC`)
      .all(runId) as CommitRow[];
    return rows.map(parseCommitRow);
  });
}

/**
 * Explicit linear-history validator (§68 — commit-time and test-time only,
 * never a store-open scan): root sequence 1 with null parent, sequence N's
 * parent is commit N-1, each base snapshot is the parent's resulting
 * snapshot, and HEAD is the mutually consistent chain tip.
 */
export function getCommitChainRecord(store: PlanStore, runId: string): PlanCommitView[] {
  return store.withRead((tx) => {
    const commits = (
      tx.prepare(`SELECT ${COMMIT_COLUMNS} FROM plan_commits WHERE run_id = ? ORDER BY sequence ASC`).all(runId) as CommitRow[]
    ).map(parseCommitRow);
    const head = getHeadPairInTx(tx, runId);

    const problems: string[] = [];
    if (commits.length === 0) {
      if (head !== null && head.headCommitId !== null) {
        problems.push(`HEAD references commit '${head.headCommitId}' but the run has no commits`);
      }
      if (problems.length > 0) {
        throw new RuntimeError("STORE_SCHEMA_INVALID", "commit chain violates linear history", {
          detail: { runId, problems },
        });
      }
      return [];
    }

    commits.forEach((commit, index) => {
      if (index === 0) {
        if (commit.sequence !== 1) problems.push(`root commit sequence must be 1, found ${commit.sequence}`);
        if (commit.parentCommitId !== null) problems.push("root commit must have a null parent");
      } else {
        const previous = commits[index - 1]!;
        if (commit.sequence !== previous.sequence + 1) {
          problems.push(`commit ${commit.commitId} sequence ${commit.sequence} breaks the linear chain`);
        }
        if (commit.parentCommitId !== previous.commitId) {
          problems.push(`commit ${commit.commitId} parent must be ${previous.commitId}`);
        }
        if (commit.baseSnapshotId !== previous.resultingSnapshotId) {
          problems.push(`commit ${commit.commitId} base snapshot must be the parent's resulting snapshot`);
        }
      }
    });

    const tip = commits[commits.length - 1]!;
    if (head === null || head.headCommitId !== tip.commitId) {
      problems.push(`HEAD commit must be the chain tip '${tip.commitId}'`);
    } else if (head.headSnapshotId !== tip.resultingSnapshotId) {
      problems.push("HEAD snapshot must be the tip commit's resulting snapshot");
    }

    if (problems.length > 0) {
      throw new RuntimeError("STORE_SCHEMA_INVALID", "commit chain violates linear history", {
        detail: { runId, problems },
      });
    }
    return commits;
  });
}
