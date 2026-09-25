/**
 * Proposal persistence (frozen plan Phase 6 §6–§10/§26/§27/§72).
 *
 * Layering mirrors planning-runs.ts: SQL lives here; the application service
 * orchestrates transactions and never writes SQL. Proposal identity, frozen
 * revisions, and per-revision lifecycle state are three separate concerns —
 * content is immutable at the DATABASE level (proposal_revisions triggers),
 * while only state walks the frozen awaiting_approval → approved/rejected/
 * superseded graph (state triggers + Application checks).
 *
 * Every InTx core is composable into the larger PlanCommit transaction.
 */

import { canonicalJson } from "../core/canonical-json.js";
import {
  isProposalStatus,
  parseNormalizedProposalChange,
  parseProposalDependencies,
  parseProposalImpact,
  parseProposalScope,
  proposalInvalid,
  type ImpactAnalysis,
  type NormalizedProposalChange,
  type ProposalScope,
  type ProposalStatus,
  type ProposalType,
} from "../core/proposal.js";
import { isProposalType } from "../core/proposal.js";
import { memoryRevisionInvalid, parseMemoryRefShape, sortMemoryRefs, type MemoryRef } from "../core/memory-refs.js";
import { RuntimeError } from "../runtime/errors.js";
import type { PlanStore } from "./sqlite-store.js";
import type { StoreTx } from "./transaction.js";

export function proposalNotFoundError(proposalId: string, revision?: number): RuntimeError {
  return new RuntimeError("PROPOSAL_NOT_FOUND", `no proposal revision exists for '${proposalId}'${revision === undefined ? "" : `@${revision}`}`, {
    detail: { proposalId, ...(revision === undefined ? {} : { revision }) },
  });
}

export type ProposalTx = StoreTx;

export interface ProposalRevisionView {
  runId: string;
  proposalId: string;
  revision: number;
  type: ProposalType;
  scope: ProposalScope;
  title: string;
  summary: string;
  changes: NormalizedProposalChange[];
  dependencies: MemoryRef[];
  impact: ImpactAnalysis;
  baseRunRevision: number;
  baseHeadSnapshotId: string | null;
  baseHeadCommitId: string | null;
  canonicalJson: string;
  proposalHash: string;
  createdAt: string;
}

interface ProposalRevisionRow {
  runId: string;
  proposalId: string;
  revision: number;
  proposalType: string;
  scopeJson: string;
  title: string;
  summary: string;
  changesJson: string;
  dependenciesJson: string;
  impactJson: string;
  baseRunRevision: number;
  baseHeadSnapshotId: string | null;
  baseHeadCommitId: string | null;
  canonicalJson: string;
  proposalHash: string;
  createdAt: string;
}

const REVISION_COLUMNS =
  "run_id AS runId, proposal_id AS proposalId, revision, proposal_type AS proposalType, scope_json AS scopeJson, title, summary, changes_json AS changesJson, dependencies_json AS dependenciesJson, impact_json AS impactJson, base_run_revision AS baseRunRevision, base_head_snapshot_id AS baseHeadSnapshotId, base_head_commit_id AS baseHeadCommitId, canonical_json AS canonicalJson, proposal_hash AS proposalHash, created_at AS createdAt";

function parseProposalRevisionRow(row: ProposalRevisionRow): ProposalRevisionView {
  const problems: string[] = [];
  if (typeof row.proposalType !== "string" || !isProposalType(row.proposalType)) problems.push("proposal_type");
  if (typeof row.title !== "string" || row.title.trim() === "") problems.push("title");
  if (typeof row.summary !== "string") problems.push("summary");
  if (typeof row.baseRunRevision !== "number" || row.baseRunRevision < 1) problems.push("base_run_revision");
  if (typeof row.proposalHash !== "string" || !row.proposalHash.startsWith("sha256:")) problems.push("proposal_hash");
  if (problems.length > 0) {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "proposal_revisions row is corrupt", {
      detail: { fields: problems, proposalId: row.proposalId, revision: row.revision },
    });
  }
  let scope: ProposalScope;
  let changes: NormalizedProposalChange[];
  let dependencies: MemoryRef[];
  let impact: ImpactAnalysis;
  try {
    scope = parseProposalScope(JSON.parse(row.scopeJson));
    changes = (JSON.parse(row.changesJson) as unknown[]).map((change) => parseNormalizedProposalChange(change, row.runId));
    dependencies = sortMemoryRefs(parseProposalDependencies(JSON.parse(row.dependenciesJson), row.runId));
    impact = parseProposalImpact(JSON.parse(row.impactJson));
  } catch (err) {
    if (err instanceof RuntimeError) throw err;
    throw memoryRevisionInvalid(`persisted proposal revision for '${row.proposalId}@${row.revision}' does not parse`);
  }
  return {
    runId: row.runId,
    proposalId: row.proposalId,
    revision: row.revision,
    type: row.proposalType as ProposalType,
    scope,
    title: row.title,
    summary: row.summary,
    changes,
    dependencies,
    impact,
    baseRunRevision: row.baseRunRevision,
    baseHeadSnapshotId: row.baseHeadSnapshotId,
    baseHeadCommitId: row.baseHeadCommitId,
    canonicalJson: row.canonicalJson,
    proposalHash: row.proposalHash,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Transaction-scoped write primitives (the engine composes these)
// ---------------------------------------------------------------------------

/** Register a proposal identity. Ids are always server-generated. */
export function insertProposalIdentityInTx(
  tx: ProposalTx,
  input: {
    runId: string;
    proposalId: string;
    prepareRequestId?: string;
    prepareRequestInputJson?: string;
  },
  now: string,
): void {
  const run = tx.prepare("SELECT run_id FROM planning_runs WHERE run_id = ?").get(input.runId);
  if (run === undefined) {
    throw new RuntimeError("RUN_NOT_FOUND", `no PlanningRun exists for '${input.runId}'`, {
      detail: { runId: input.runId },
    });
  }
  const existing = tx
    .prepare("SELECT run_id FROM proposals WHERE run_id = ? AND proposal_id = ?")
    .get(input.runId, input.proposalId);
  if (existing !== undefined) {
    throw proposalInvalid("proposal identity already exists", { proposalId: input.proposalId });
  }
  tx.prepare(
    "INSERT INTO proposals (run_id, proposal_id, prepare_request_id, prepare_request_input_json, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    input.runId,
    input.proposalId,
    input.prepareRequestId ?? null,
    input.prepareRequestInputJson ?? null,
    now,
  );
}

export interface InsertProposalRevisionInput {
  runId: string;
  proposalId: string;
  revision: number;
  type: ProposalType;
  scope: ProposalScope;
  title: string;
  summary: string;
  changes: NormalizedProposalChange[];
  dependencies: MemoryRef[];
  impact: ImpactAnalysis;
  baseRunRevision: number;
  baseHeadSnapshotId: string | null;
  baseHeadCommitId: string | null;
  canonicalJson: string;
  proposalHash: string;
}

/**
 * Freeze one proposal revision: strict max+1, never overwrite, never gap.
 * Content arrives already normalized and hash-covered; this primitive pins
 * it into the database.
 */
export function insertProposalRevisionInTx(tx: ProposalTx, input: InsertProposalRevisionInput, now: string): void {
  const maxRow = tx
    .prepare("SELECT max(revision) AS maxRevision FROM proposal_revisions WHERE run_id = ? AND proposal_id = ?")
    .get(input.runId, input.proposalId) as { maxRevision: number | null } | undefined;
  const nextRevision = (maxRow?.maxRevision ?? 0) + 1;
  if (input.revision !== nextRevision) {
    throw proposalInvalid(`proposal revision must be exactly ${nextRevision} (no gaps, no reuse)`, {
      proposalId: input.proposalId,
      requested: input.revision,
      expected: nextRevision,
    });
  }
  tx.prepare(
    `INSERT INTO proposal_revisions
      (run_id, proposal_id, revision, proposal_type, scope_json, title, summary, changes_json, dependencies_json, impact_json, base_run_revision, base_head_snapshot_id, base_head_commit_id, canonical_json, proposal_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.runId,
    input.proposalId,
    input.revision,
    input.type,
    canonicalJson(input.scope),
    input.title,
    input.summary,
    canonicalJson(input.changes),
    canonicalJson(input.dependencies.map((ref) => ({ kind: ref.kind, id: ref.id, revision: ref.revision }))),
    canonicalJson(input.impact),
    input.baseRunRevision,
    input.baseHeadSnapshotId,
    input.baseHeadCommitId,
    input.canonicalJson,
    input.proposalHash,
    now,
  );
}

/** Every revision starts awaiting_approval (insert trigger enforces). */
export function insertProposalStateInTx(
  tx: ProposalTx,
  input: { runId: string; proposalId: string; revision: number },
  now: string,
): void {
  tx.prepare(
    "INSERT INTO proposal_states (run_id, proposal_id, revision, status, created_at, updated_at) VALUES (?, ?, ?, 'awaiting_approval', ?, ?)",
  ).run(input.runId, input.proposalId, input.revision, now, now);
}

/**
 * Walk the frozen status graph: awaiting_approval → approved/rejected/
 * superseded. Returns false when the row is missing; throws for non-awaiting
 * statuses (the transition guard trigger is the second line of defense).
 */
export function transitionProposalStateInTx(
  tx: ProposalTx,
  input: { runId: string; proposalId: string; revision: number; to: ProposalStatus },
  now: string,
): boolean {
  const row = tx
    .prepare("SELECT status FROM proposal_states WHERE run_id = ? AND proposal_id = ? AND revision = ?")
    .get(input.runId, input.proposalId, input.revision) as { status: string } | undefined;
  if (row === undefined) return false;
  if (row.status !== "awaiting_approval") {
    throw new RuntimeError(
      row.status === "superseded" ? "PROPOSAL_SUPERSEDED" : "PROPOSAL_NOT_AWAITING_APPROVAL",
      `proposal '${input.proposalId}@${input.revision}' is ${row.status}, not awaiting_approval`,
      { detail: { proposalId: input.proposalId, revision: input.revision, status: row.status } },
    );
  }
  const result = tx
    .prepare(
      "UPDATE proposal_states SET status = ?, updated_at = ? WHERE run_id = ? AND proposal_id = ? AND revision = ? AND status = 'awaiting_approval'",
    )
    .run(input.to, now, input.runId, input.proposalId, input.revision) as { changes?: number };
  return (result.changes ?? 0) === 1;
}

export function getProposalStateInTx(
  tx: ProposalTx,
  input: { runId: string; proposalId: string; revision: number },
): ProposalStatus | null {
  const row = tx
    .prepare("SELECT status FROM proposal_states WHERE run_id = ? AND proposal_id = ? AND revision = ?")
    .get(input.runId, input.proposalId, input.revision) as { status: string } | undefined;
  if (row === undefined) return null;
  if (!isProposalStatus(row.status)) {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "proposal_states row has an unknown status", {
      detail: { proposalId: input.proposalId, revision: input.revision, status: row.status },
    });
  }
  return row.status;
}

/** The run's single awaiting proposal revision (partial unique index bounds it to one). */
export function findAwaitingProposalStateInTx(
  tx: ProposalTx,
  runId: string,
): { proposalId: string; revision: number } | null {
  const row = tx
    .prepare(
      "SELECT proposal_id AS proposalId, revision FROM proposal_states WHERE run_id = ? AND status = 'awaiting_approval' LIMIT 1",
    )
    .get(runId) as { proposalId: string; revision: number } | undefined;
  return row ?? null;
}

export function getProposalRevisionInTx(
  tx: ProposalTx,
  input: { runId: string; proposalId: string; revision: number },
): ProposalRevisionView | null {
  const row = tx
    .prepare(`SELECT ${REVISION_COLUMNS} FROM proposal_revisions WHERE run_id = ? AND proposal_id = ? AND revision = ?`)
    .get(input.runId, input.proposalId, input.revision) as ProposalRevisionRow | undefined;
  return row === undefined ? null : parseProposalRevisionRow(row);
}

// ---------------------------------------------------------------------------
// Read model (never mutates; no writable binding required)
// ---------------------------------------------------------------------------

export interface ProposalRevisionStatusView extends ProposalRevisionView {
  status: ProposalStatus;
}

export function getProposalRevisionRecord(
  store: PlanStore,
  input: { runId: string; proposalId: string; revision: number },
): ProposalRevisionStatusView | null {
  return store.withRead((tx) => {
    const view = getProposalRevisionInTx(tx, input);
    if (view === null) return null;
    const status = getProposalStateInTx(tx, input);
    if (status === null) {
      throw new RuntimeError("STORE_SCHEMA_INVALID", "proposal revision has no lifecycle state row", {
        detail: { proposalId: input.proposalId, revision: input.revision },
      });
    }
    return { ...view, status };
  });
}

/** The run's awaiting proposal (at most one — partial unique index, §10). */
export function getAwaitingProposalRecord(
  store: PlanStore,
  runId: string,
): ProposalRevisionStatusView | null {
  return store.withRead((tx) => {
    const awaiting = findAwaitingProposalStateInTx(tx, runId);
    if (awaiting === null) return null;
    const view = getProposalRevisionInTx(tx, { runId, proposalId: awaiting.proposalId, revision: awaiting.revision });
    if (view === null) {
      throw new RuntimeError("STORE_SCHEMA_INVALID", "awaiting proposal state references a missing revision", {
        detail: { runId, proposalId: awaiting.proposalId, revision: awaiting.revision },
      });
    }
    return { ...view, status: "awaiting_approval" as const };
  });
}

export function listProposalRevisionsRecord(
  store: PlanStore,
  proposalId: string,
): ProposalRevisionStatusView[] {
  return store.withRead((tx) => {
    const rows = tx
      .prepare(
        `SELECT ${REVISION_COLUMNS} FROM proposal_revisions WHERE proposal_id = ? ORDER BY revision ASC`,
      )
      .all(proposalId) as ProposalRevisionRow[];
    return rows.map((row) => {
      const view = parseProposalRevisionRow(row);
      const status = getProposalStateInTx(tx, { runId: view.runId, proposalId, revision: view.revision });
      if (status === null) {
        throw new RuntimeError("STORE_SCHEMA_INVALID", "proposal revision has no lifecycle state row", {
          detail: { proposalId, revision: view.revision },
        });
      }
      return { ...view, status };
    });
  });
}

/** Parse helper reused by the engine when reloading stored canonical JSON. */
export function parseStoredDependencies(value: unknown, runId: string): MemoryRef[] {
  const refs = parseProposalDependencies(value, runId);
  for (const ref of refs) {
    if (parseMemoryRefShape(ref) === null) throw proposalInvalid("dependency ref is malformed");
  }
  return refs;
}
