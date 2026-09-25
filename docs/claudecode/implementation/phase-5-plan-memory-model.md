# Phase 5 Implementation Note — Plan Memory Immutable Revision Model

Scope: how the committed Plan Memory data model is implemented. Authority
remains `docs/claudecode/spec/claude-code-phase-plan-v0.1-architecture-spec.md`
(§9–§18 memory model, §25 storage, §39 invariants); nothing here amends it.
Built on the Phase 2 migration/backup framework (migration `3 → 4`), the
Phase 4 PlanningRun root, and the Phase 3 binding primitives.

## The headline

> **Phase 5 establishes the committed-memory representation but
> intentionally provides no production path that can create committed design
> state. Proposal → Approval → PlanCommit in Phase 6 becomes the first
> authorized writer.**

All write primitives below are transaction-scoped Store internals used by
tests to build fixtures. Nothing in the runtime (dispatcher, MCP, doctor,
services) calls them; no admin/force/trusted flags exist — the boundary is
the package structure plus the absence of any production caller, and the
database itself refuses history rewrites from any connection.

## Schema v4 (migration `3 → 4 plan-memory-foundation`)

```sql
memory_artifacts (run_id, kind, artifact_id) PK, created_at
  FK run_id → planning_runs
memory_revisions (run_id, kind, artifact_id, revision) PK, CHECK revision >= 1,
  content_json NOT NULL, compact_projection NOT NULL,
  full_projection NULLABLE, contract_json NULLABLE, created_at
  composite FK → memory_artifacts(run_id, kind, artifact_id)
plan_snapshots (snapshot_id PK, run_id FK, created_at,
  UNIQUE(snapshot_id, run_id), UNIQUE(run_id, snapshot_id))
snapshot_members (snapshot_id, kind, artifact_id) PK, run_id, revision
  FK (run_id,kind,artifact_id,revision) → memory_revisions   -- no dangling refs
  FK (snapshot_id, run_id) → plan_snapshots                  -- no cross-run refs
plan_heads (run_id PK, head_snapshot_id NOT NULL, updated_at
  FK (run_id, head_snapshot_id) → plan_snapshots(run_id, snapshot_id))
```

Immutability triggers (`*_no_update`, `*_no_delete` → `RAISE(ABORT)`) guard
memory_artifacts, memory_revisions, plan_snapshots, and snapshot_members —
verified by RAW-connection UPDATE/DELETE tests. `plan_heads` is deliberately
mutable: it is a materialized pointer, and the future PlanCommit engine is
its only legitimate mover. Raw tests also prove a snapshot cannot reference
a cross-run revision (composite FK rejects before validation even runs).

## Artifact model

- Kinds (frozen set): `constraint`, `decision`, `architecture`, `section`,
  `open_question`, `conflict`. Proposal/Evidence/FinalPlan are NOT memory
  kinds.
- Identity = (run_id, kind, artifact_id) — opaque, stable, revision-
  independent; readable prefixes (DEC-123) are UX only. At most ONE
  architecture artifact identity per run (`ARCH` revisions, never parallel
  ARCH artifacts).
- Revision = identity + strictly sequential positive number (max+1; no gaps,
  no reuse, no overwrite). Explicit revisions at/below max →
  `MEMORY_REVISION_CONFLICT` (lost race/duplicate); beyond max+1 →
  `MEMORY_REVISION_INVALID` (gap).
- Typed content, not blobs: each kind has a validating parser
  (`parseMemoryRevisionContent` dispatch). Corrupt persisted JSON →
  `STORE_SCHEMA_INVALID`; wrong shape → `MEMORY_REVISION_INVALID` (domain
  vs corruption are distinct categories). Same-run is enforced for every
  embedded MemoryRef; cross-run refs are invalid content.

## Kind highlights

- **Constraint**: source (user/repository/environment/runtime), statement,
  severity (hard/soft), creation-time status. No mutable row: HEAD snapshot
  membership decides what is currently effective.
- **Decision**: title/statement/rationale/alternatives/consequences/scope +
  same-run supporting refs; optional `supersedes` must reference the same
  run's decision at an exact EARLIER revision (enforced by shape + ordering
  at validation; existence at snapshot time).
- **Architecture**: summary/components/boundaries/dataFlows/principles +
  question/decision refs, validated structured JSON (no SQL sub-tables in
  v0.1).
- **Section**: full design content; `dependencies[]` reference SECTION
  IDENTITIES (the snapshot picks exact dependency revisions); decision/
  question/impact refs same-run. The SectionContract is an immutable
  projection bound to the exact (sectionId, revision) — persisted atomically
  with the revision (`contract_json`), required for sections, forbidden
  elsewhere, byte-stable on every read.
- **OpenQuestion**: question/blocking/scope/status; `resolved` requires a
  resolution; `resolvedBy` must be a same-run decision revision. Resolution
  = new revision Q@2, never an UPDATE of Q@1.
- **Conflict**: type/refs/description/severity/status/resolution — refs are
  same-run exact MemoryRefs. Blocking semantics only gate in later
  Finalization; Phase 5 just stores the fact.

## canonicalJson

`src/core/canonical-json.ts`: deterministic structured serialization (sorted
keys, compact) so identical revisions always serialize identically — the
foundation for Phase 6 Proposal hashing. No hashing happens here.

## Section DAG

`validateSectionDag` (pure core): rejects self dependencies, missing section
ids, duplicate edges, and cycles (iterative DFS, deterministic order,
reports the cycle path) → `SECTION_DAG_INVALID`. Snapshot-time validation
re-runs the DAG over the CHOSEN revisions of the snapshot, since dependency
definitions can change between revisions of the same section.

## Snapshots

Snapshot = id (`snap_<uuid>`, injectable) + run + exact ref set. Not a
database copy — revisions are stored once and referenced. Insert checks
(frozen plan §33): run exists; every ref exists and is same-run; no
duplicate artifact identity; ≤ 1 architecture; section DAG valid over chosen
revisions; failure → `SNAPSHOT_INVALID` / `MEMORY_REVISION_NOT_FOUND`. An
empty ref set is representable but never created implicitly (fresh runs get
NO snapshot and NO HEAD row). Membership is immutable; two snapshots with
the same refs are both valid (no one-snapshot-per-base-state restriction).
Reads are deterministically ordered (kind, artifact_id, revision) — never
SQLite natural order.

## HEAD

`plan_heads` — one row per run, absent until first set. `setHeadSnapshotInTx`
is compare-and-swap: `expectedHeadSnapshotId (| null)` must match the
current pointer exactly or → `STALE_MEMORY_HEAD` (distinct from
`STALE_RUN_REVISION`); the next snapshot must exist and belong to the same
run (`MEMORY_HEAD_INVALID` otherwise — DB composite FK enforces the same).
Empty-HEAD CAS (`null → SNAP-001`) works for the first Phase 6 commit. No
`plan_commits`, no `head_commit_id`, no head-history table — the Phase 6
commit chain will BE the history. HEAD movement does not touch
PlanningRun.revision; the two domains stay independent.

## Read API (internal, read-only)

`readMemoryRevision(ref)` (parsed typed content + compact/full/contract
projections), `readSectionContract(ref)` (null for non-sections),
`getSnapshot(id)`, `getHeadSnapshot(runId)`, `listSnapshotRefs(id)` — all
deterministically ordered, never mutating, never requiring a writable
SessionBinding, and fully recoverable from snapshot+refs+revisions alone
(no Claude transcript dependency). DetailLevel vocabulary exists only as the
identity/summary/full split these primitives already support; no context
budgeting.

## Internal-only write boundary

`createInternalPlanMemoryWriter` + the `*InTx` primitives
(`insertArtifactIdentityInTx`, `insertMemoryRevisionInTx`,
`insertSnapshotInTx`, `setHeadSnapshotInTx`) live in
`src/store/plan-memory.ts`. They are reachable from tests and (future)
Phase 6 only; the dispatcher, MCP layer, doctor, and application services
contain no calls. `tools/list` remains `[]`.

## Schema v4 integrity validation

Structural checks run at store open (cheap sqlite_master lookups): memory
tables present, all eight immutability triggers present, indexes present.
Semantic snapshot validation (DAG, contracts, JSON shape, ref existence) is
on-demand at creation/read — store open never scans memory history.

## Migration 3→4 regression

Real schema-3 stores (built surgically with Phase 1–4 rows + sentinel)
migrate with a validated `pre-schema-3-4` backup; all old rows survive;
memory tables start empty; HEAD absent; history `[1,2,3,4]`. Injected
failing-004 rolls back to a fully valid schema-3 store. A real schema-3
writer (`runWrite` floor=3) is fenced `STORE_SCHEMA_TOO_NEW` after
migration.

## Intentional deferrals (Phase 6+)

Proposal/Approval/PlanCommit engine and commit chain, canonical proposal
hashing, awaiting_approval workflow, artifact completion/reopen
transactions, section completion semantics, Evidence fields, Context
Assembler/budgeting, FinalizationGate blocking reads, command idempotency
ledger, head-history (the commit chain replaces it).
