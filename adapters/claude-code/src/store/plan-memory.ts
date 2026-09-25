/**
 * Plan Memory persistence (frozen plan §46/§47/§57).
 *
 * TRANSACTION-SCOPED, INTERNAL-ONLY write primitives. There is deliberately
 * NO production caller: Phase 5 establishes the committed-memory
 * REPRESENTATION while the runtime provides no path that can create
 * committed design state. Proposal → Approval → PlanCommit (Phase 6) becomes
 * the first authorized writer; its Transaction Engine will be the only
 * production caller of the insert and setHead primitives. Tests use them
 * directly to build fixtures — that is the sanctioned boundary, not a
 * security token (no admin/force/trusted flags exist; immutability is
 * enforced by the DATABASE).
 *
 * The read side is different: read-only Plan Memory APIs are for future
 * Build/validator/context-assembler consumers and never mutate, never
 * require a writable SessionBinding, and never touch a Claude transcript.
 */

import {
  parseMemoryRevisionContent,
  type MemoryRevisionContent,
  type SectionContent,
} from "../core/memory-artifacts.js";
import { assertValidSectionDag, type SectionDagEntry } from "../core/section-dag.js";
import {
  memoryRevisionInvalid,
  sortMemoryRefs,
  type MemoryArtifactKind,
  type MemoryRef,
} from "../core/memory-refs.js";
import { canonicalJson } from "../core/canonical-json.js";
import { RuntimeError } from "../runtime/errors.js";
import type { StoreClock } from "./migration-runner.js";
import type { PlanStore } from "./sqlite-store.js";

export type MemoryWriteTx = {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
};

export function memoryError(
  code:
    | "MEMORY_ARTIFACT_NOT_FOUND"
    | "MEMORY_REVISION_NOT_FOUND"
    | "MEMORY_REVISION_CONFLICT"
    | "MEMORY_REVISION_INVALID"
    | "SNAPSHOT_NOT_FOUND"
    | "SNAPSHOT_INVALID"
    | "STALE_MEMORY_HEAD"
    | "MEMORY_HEAD_INVALID",
  message: string,
  detail?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(code, message, { detail, recoverable: false });
}

const REVISION_COLUMNS =
  "run_id AS runId, kind, artifact_id AS artifactId, revision, content_json AS contentJson, compact_projection AS compactProjection, full_projection AS fullProjection, contract_json AS contractJson, created_at AS createdAt";

interface RevisionRow {
  runId: string;
  kind: MemoryArtifactKind;
  artifactId: string;
  revision: number;
  contentJson: string;
  compactProjection: string;
  fullProjection: string | null;
  contractJson: string | null;
  createdAt: string;
}

function requireRunInTx(tx: MemoryWriteTx, runId: string): void {
  const run = tx.prepare("SELECT run_id FROM planning_runs WHERE run_id = ?").get(runId);
  if (run === undefined) {
    throw runStateNotFoundError(runId);
  }
}

function runStateNotFoundError(runId: string): RuntimeError {
  return new RuntimeError("RUN_NOT_FOUND", `no PlanningRun exists for '${runId}'`, {
    detail: { runId },
  });
}

/**
 * Register an artifact identity (run + kind + artifact id). Identities are
 * immutable once created; a run has AT MOST ONE architecture identity (§15).
 */
export function insertArtifactIdentityInTx(
  tx: MemoryWriteTx,
  input: { runId: string; kind: MemoryArtifactKind; artifactId: string },
  now: string,
): void {
  requireRunInTx(tx, input.runId);
  const existing = tx
    .prepare("SELECT run_id FROM memory_artifacts WHERE run_id = ? AND kind = ? AND artifact_id = ?")
    .get(input.runId, input.kind, input.artifactId);
  if (existing !== undefined) {
    throw memoryError("MEMORY_REVISION_CONFLICT", "memory artifact identity already exists", {
      runId: input.runId,
      kind: input.kind,
      artifactId: input.artifactId,
    });
  }
  if (input.kind === "architecture") {
    const other = tx
      .prepare("SELECT artifact_id FROM memory_artifacts WHERE run_id = ? AND kind = 'architecture'")
      .get(input.runId);
    if (other !== undefined) {
      throw memoryError(
        "MEMORY_REVISION_CONFLICT",
        "a PlanningRun has at most one architecture artifact identity",
        { runId: input.runId, existing: (other as { artifact_id: string }).artifact_id },
      );
    }
  }
  tx.prepare(
    "INSERT INTO memory_artifacts (run_id, kind, artifact_id, created_at) VALUES (?, ?, ?, ?)",
  ).run(input.runId, input.kind, input.artifactId, now);
}

export interface InsertMemoryRevisionInput {
  runId: string;
  kind: MemoryArtifactKind;
  artifactId: string;
  /** Optional explicit next revision; defaults to current max + 1 (§9). */
  revision?: number;
  content: MemoryRevisionContent;
  compactProjection: string;
  fullProjection?: string;
  /** Optional explicit timestamp; the facade injects the clock by default. */
  now?: string;
}

/**
 * Append the next immutable revision of an artifact identity. The revision
 * number must be exactly current-max + 1 (no gaps, no reuse); the content
 * and its stable projections are persisted atomically. Sections must carry
 * their contract (validated inside the content); non-sections persist
 * contract_json = NULL. Duplicate exact revisions conflict — never
 * overwritten (§48).
 */
export function insertMemoryRevisionInTx(
  tx: MemoryWriteTx,
  input: InsertMemoryRevisionInput,
): MemoryRef {
  const now = input.now ?? new Date(0).toISOString();
  requireRunInTx(tx, input.runId);
  const identity = tx
    .prepare("SELECT run_id FROM memory_artifacts WHERE run_id = ? AND kind = ? AND artifact_id = ?")
    .get(input.runId, input.kind, input.artifactId);
  if (identity === undefined) {
    throw memoryError("MEMORY_ARTIFACT_NOT_FOUND", "memory artifact identity is not registered", {
      runId: input.runId,
      kind: input.kind,
      artifactId: input.artifactId,
    });
  }
  const maxRow = tx
    .prepare("SELECT max(revision) AS maxRevision FROM memory_revisions WHERE run_id = ? AND kind = ? AND artifact_id = ?")
    .get(input.runId, input.kind, input.artifactId) as { maxRevision: number | null } | undefined;
  const nextRevision = (maxRow?.maxRevision ?? 0) + 1;
  if (input.revision !== undefined) {
    // An explicit revision at or below the current max is a lost race or a
    // duplicate append (§55/§48): conflict, never overwrite. A revision
    // beyond max+1 would leave a gap (§9): invalid.
    if (input.revision <= (maxRow?.maxRevision ?? 0)) {
      throw memoryError("MEMORY_REVISION_CONFLICT", "a newer revision of this artifact already exists", {
        runId: input.runId,
        kind: input.kind,
        artifactId: input.artifactId,
        requested: input.revision,
        current: maxRow?.maxRevision ?? 0,
      });
    }
    if (input.revision !== nextRevision) {
      throw memoryRevisionInvalid(`revision must be exactly ${nextRevision} (no gaps, no reuse)`);
    }
  }
  const revision = nextRevision;

  // Kind-specific content validation (shape, same-run refs, contract rules).
  parseMemoryRevisionContent(input.kind, input.content, input.runId, input.artifactId, revision);

  // Contract projection rules: sections REQUIRE their contract; other kinds
  // must not carry one (contract_json stays NULL, §19).
  let contractJson: string | null = null;
  if (input.kind === "section") {
    const sectionContent = input.content as SectionContent;
    if (sectionContent.contract === undefined) {
      throw memoryRevisionInvalid("section revisions require a SectionContract");
    }
    contractJson = canonicalJson(sectionContent.contract);
  } else if ("contract" in input.content && input.content.contract !== undefined) {
    throw memoryRevisionInvalid("only section revisions carry a contract projection");
  }

  const contentJson = canonicalJson(input.content);

  tx.prepare(
    "INSERT INTO memory_revisions (run_id, kind, artifact_id, revision, content_json, compact_projection, full_projection, contract_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    input.runId,
    input.kind,
    input.artifactId,
    revision,
    contentJson,
    input.compactProjection,
    input.fullProjection ?? null,
    contractJson,
    now,
  );
  return { runId: input.runId, kind: input.kind, id: input.artifactId, revision };
}

export interface InsertSnapshotInput {
  runId: string;
  refs: MemoryRef[];
}

export interface MemorySnapshot {
  snapshotId: string;
  runId: string;
  refs: MemoryRef[];
  createdAt: string;
}

/**
 * Create an immutable snapshot: exact MemoryRefs only (never copied
 * content). Integrity checks (§33): refs exist, same-run, no duplicate
 * artifact identity, ≤ 1 architecture, section DAG valid over the chosen
 * revisions. An empty ref set is representable (recorded choice, §78) but
 * never created implicitly.
 */
export function insertSnapshotInTx(
  tx: MemoryWriteTx,
  input: InsertSnapshotInput,
  clock: StoreClock,
): MemorySnapshot {
  requireRunInTx(tx, input.runId);
  const refs = sortMemoryRefs(input.refs);
  for (const ref of refs) {
    if (ref.runId !== input.runId) {
      throw memoryError("SNAPSHOT_INVALID", "snapshot refs cross PlanningRun boundaries", { ref });
    }
    const exists = tx
      .prepare(
        "SELECT revision FROM memory_revisions WHERE run_id = ? AND kind = ? AND artifact_id = ? AND revision = ?",
      )
      .get(ref.runId, ref.kind, ref.id, ref.revision);
    if (exists === undefined) {
      throw memoryError("MEMORY_REVISION_NOT_FOUND", "snapshot references a missing revision", { ref });
    }
  }
  const identities = new Set(refs.map((ref) => `${ref.kind}:${ref.id}`));
  if (identities.size !== refs.length) {
    throw memoryError("SNAPSHOT_INVALID", "snapshot contains two revisions of one artifact identity");
  }
  const architectureRefs = refs.filter((ref) => ref.kind === "architecture");
  if (architectureRefs.length > 1) {
    throw memoryError("SNAPSHOT_INVALID", "a snapshot contains at most one architecture revision");
  }

  // Snapshot-level section DAG validation over the CHOSEN revisions.
  const sectionEntries: SectionDagEntry[] = [];
  for (const ref of refs) {
    if (ref.kind !== "section") continue;
    const row = tx
      .prepare(
        `SELECT ${REVISION_COLUMNS} FROM memory_revisions WHERE run_id = ? AND kind = 'section' AND artifact_id = ? AND revision = ?`,
      )
      .get(ref.runId, ref.id, ref.revision) as RevisionRow | undefined;
    if (row === undefined) {
      throw memoryError("MEMORY_REVISION_NOT_FOUND", "snapshot references a missing section revision", { ref });
    }
    const content = parseMemoryRevisionContent("section", JSON.parse(row.contentJson), row.runId, row.artifactId, row.revision);
    if (!("dependencies" in content)) {
      throw memoryError("SNAPSHOT_INVALID", "section revision is missing its dependency graph", { ref });
    }
    sectionEntries.push({ sectionId: ref.id, dependencies: content.dependencies });
  }
  assertValidSectionDag(sectionEntries);

  const snapshotId = `snap_${clock.newId()}`;
  const now = clock.nowIso();
  tx.prepare("INSERT INTO plan_snapshots (snapshot_id, run_id, created_at) VALUES (?, ?, ?)").run(
    snapshotId,
    input.runId,
    now,
  );
  for (const ref of refs) {
    tx.prepare(
      "INSERT INTO snapshot_members (snapshot_id, run_id, kind, artifact_id, revision) VALUES (?, ?, ?, ?, ?)",
    ).run(snapshotId, ref.runId, ref.kind, ref.id, ref.revision);
  }
  return { snapshotId, runId: input.runId, refs, createdAt: now };
}

/**
 * HEAD compare-and-swap (frozen plan §57). INTERNAL: Phase 6's PlanCommit
 * engine is the only future production caller; Phase 5's runtime never moves
 * HEAD. `expectedHeadSnapshotId = null` matches the absent-head state of a
 * fresh run. Mismatch → STALE_MEMORY_HEAD (a different domain from
 * STALE_RUN_REVISION).
 */
export function setHeadSnapshotInTx(
  tx: MemoryWriteTx,
  input: { runId: string; expectedHeadSnapshotId: string | null; nextSnapshotId: string },
  clock: StoreClock,
): { runId: string; headSnapshotId: string } {
  requireRunInTx(tx, input.runId);
  const snapshot = tx
    .prepare("SELECT run_id FROM plan_snapshots WHERE snapshot_id = ?")
    .get(input.nextSnapshotId) as { run_id: string } | undefined;
  if (snapshot === undefined || snapshot.run_id !== input.runId) {
    throw memoryError("MEMORY_HEAD_INVALID", "HEAD must reference a snapshot of the same run", {
      runId: input.runId,
      nextSnapshotId: input.nextSnapshotId,
    });
  }
  const current = tx
    .prepare("SELECT head_snapshot_id AS headSnapshotId FROM plan_heads WHERE run_id = ?")
    .get(input.runId) as { headSnapshotId: string } | undefined;
  const currentId = current?.headSnapshotId ?? null;
  if (currentId !== input.expectedHeadSnapshotId) {
    throw memoryError(
      "STALE_MEMORY_HEAD",
      `expected HEAD ${input.expectedHeadSnapshotId ?? "null"} but current HEAD is ${currentId ?? "null"}`,
      { runId: input.runId, expected: input.expectedHeadSnapshotId, detected: currentId },
    );
  }
  const now = clock.nowIso();
  if (current === undefined) {
    tx.prepare("INSERT INTO plan_heads (run_id, head_snapshot_id, updated_at) VALUES (?, ?, ?)").run(
      input.runId,
      input.nextSnapshotId,
      now,
    );
  } else {
    tx.prepare("UPDATE plan_heads SET head_snapshot_id = ?, updated_at = ? WHERE run_id = ?").run(
      input.nextSnapshotId,
      now,
      input.runId,
    );
  }
  return { runId: input.runId, headSnapshotId: input.nextSnapshotId };
}

// ---------------------------------------------------------------------------
// Read model (never mutates; no writable binding required)
// ---------------------------------------------------------------------------

export interface MemoryRevisionView {
  ref: MemoryRef;
  content: MemoryRevisionContent;
  compactProjection: string;
  fullProjection: string | null;
  contractJson: string | null;
  createdAt: string;
}

/** Exact revision read: parsed typed content + stable projections. */
export function readMemoryRevisionRecord(
  store: PlanStore,
  ref: MemoryRef,
): MemoryRevisionView | null {
  return store.withRead((tx) => {
    const row = tx
      .prepare(`SELECT ${REVISION_COLUMNS} FROM memory_revisions WHERE run_id = ? AND kind = ? AND artifact_id = ? AND revision = ?`)
      .get(ref.runId, ref.kind, ref.id, ref.revision) as RevisionRow | undefined;
    if (row === undefined) return null;
    return viewFromRow(row);
  });
}

/** Exact SectionContract projection read (byte-stable per revision, §17). */
export function readSectionContractRecord(
  store: PlanStore,
  ref: MemoryRef,
): string | null {
  const view = readMemoryRevisionRecord(store, ref);
  if (view === null) return null;
  if (view.ref.kind !== "section") return null;
  return view.contractJson;
}

/** Deterministically ordered snapshot membership (frozen plan §62/§63). */
export function listSnapshotRefsRecord(store: PlanStore, snapshotId: string): MemoryRef[] {
  const snapshot = getSnapshotRecord(store, snapshotId);
  return snapshot === null ? [] : snapshot.refs;
}

function viewFromRow(row: RevisionRow): MemoryRevisionView {
  let raw: unknown;
  try {
    raw = JSON.parse(row.contentJson);
  } catch (err) {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "persisted memory content is not valid JSON", {
      cause: err instanceof Error ? err.message : String(err),
      detail: { ref: { runId: row.runId, kind: row.kind, id: row.artifactId, revision: row.revision } },
    });
  }
  const content = parseMemoryRevisionContent(row.kind, raw, row.runId, row.artifactId, row.revision);
  return {
    ref: { runId: row.runId, kind: row.kind, id: row.artifactId, revision: row.revision },
    content,
    compactProjection: row.compactProjection,
    fullProjection: row.fullProjection,
    contractJson: row.contractJson,
    createdAt: row.createdAt,
  };
}

export function getHeadSnapshotRecord(
  store: PlanStore,
  runId: string,
): MemorySnapshot | null {
  return store.withRead((tx) => {
    const head = tx
      .prepare("SELECT head_snapshot_id AS snapshotId FROM plan_heads WHERE run_id = ?")
      .get(runId) as { snapshotId: string } | undefined;
    if (head === undefined) return null;
    return loadSnapshotInTx(tx, head.snapshotId);
  });
}

export function getSnapshotRecord(store: PlanStore, snapshotId: string): MemorySnapshot | null {
  return store.withRead((tx) => loadSnapshotInTx(tx, snapshotId));
}

function loadSnapshotInTx(tx: MemoryWriteTx, snapshotId: string): MemorySnapshot | null {
  const snapshot = tx
    .prepare("SELECT run_id AS runId, created_at AS createdAt FROM plan_snapshots WHERE snapshot_id = ?")
    .get(snapshotId) as { runId: string; createdAt: string } | undefined;
  if (snapshot === undefined) return null;
  const members = tx
    .prepare(
      "SELECT run_id AS runId, kind, artifact_id AS artifactId, revision FROM snapshot_members WHERE snapshot_id = ? ORDER BY kind, artifact_id, revision",
    )
    .all(snapshotId) as { runId: string; kind: MemoryArtifactKind; artifactId: string; revision: number }[];
  return {
    snapshotId,
    runId: snapshot.runId,
    refs: sortMemoryRefs(
      members.map((member) => ({ runId: member.runId, kind: member.kind, id: member.artifactId, revision: member.revision })),
    ),
    createdAt: snapshot.createdAt,
  };
}

/**
 * Internal convenience facade over the transaction-scoped primitives for
 * tests and the future Phase 6 engine. NOT an application service: nothing
 * in the runtime calls these write methods.
 */
export function createInternalPlanMemoryWriter(store: PlanStore, clock: StoreClock): {
  insertArtifactIdentity(input: { runId: string; kind: MemoryArtifactKind; artifactId: string }): void;
  insertMemoryRevision(input: InsertMemoryRevisionInput): MemoryRef;
  insertSnapshot(input: InsertSnapshotInput): MemorySnapshot;
  setHeadSnapshot(input: { runId: string; expectedHeadSnapshotId: string | null; nextSnapshotId: string }): {
    runId: string;
    headSnapshotId: string;
  };
} {
  return {
    insertArtifactIdentity: (input) =>
      store.withWrite((tx) => insertArtifactIdentityInTx(tx, input, clock.nowIso())),
    insertMemoryRevision: (input) =>
      store.withWrite((tx) => insertMemoryRevisionInTx(tx, { ...input, now: input.now ?? clock.nowIso() })),
    insertSnapshot: (input) => store.withWrite((tx) => insertSnapshotInTx(tx, input, clock)),
    setHeadSnapshot: (input) => store.withWrite((tx) => setHeadSnapshotInTx(tx, input, clock)),
  };
}
