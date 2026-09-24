# Phase 2B2 Implementation Report

**Scope:** Durable Plan Memory, persistent atomic transactions, restart recovery (brief §1-§46).
**Frozen architecture:** unmodified. **Protocol:** unchanged at **v0.2** — persistence is transparent to the planning model; no model-visible contract changed.

---

## Durable Backend Selection

Per brief §3/§4, SQLite was verified against the REAL host before building anything
(`scripts/backend-gate.mjs` boots a real `opencode serve` with a probe plugin that exercises the
backend inside the host process). Result inside `opencode serve` (opencode-ai 1.18.31, Windows):

```text
nodeSqlite:      "fail: ResolveMessage: No such built-in module: node:sqlite"
bunSqlite:       "present (Bun-only API; no Node 22 equivalent for the test environment)"
fsAtomicRename:  "pass"   (write → fsync → atomic rename → overwrite-rename → read-back)
```

- `node:sqlite` (the only SQLite API available to the Node 22 test/build environment) **does not
  exist inside the OpenCode host** — the gate therefore forbids building on it (brief §4).
- `bun:sqlite` exists only in-host; the Node-side vitest/build environment has no equivalent, so
  it would force two storage implementations or a provider-abstraction framework — both forbidden.
- **Selected backend: single-file structured JSON document store** over `node:fs` — the verified
  common denominator of both runtimes: `temp file → fsync → rename` gives one atomic commit point
  per publication with crash-rollback semantics, no daemon, identical behavior in vitest and in
  the packaged plugin. Evidence recorded above; the gate script ships in the repo for re-verification.

Recorded store facts: no journal mode (rename-based atomicity), integrity enforced by document
validation + engine invariants, writer concurrency by exclusive lock file (below), transaction
primitive = one atomic whole-document publication.

## Storage Location / Project Isolation

- Durable state lives at `ULTRA_PLAN_DATA_DIR` (env override for tests) or by default
  `~/.local/share/switchboard/ultra-plan/projects/<sha256(projectID)[0:24]>/plan-store.json` —
  plugin-owned application data, NOT source-controlled repository files, never derived from model
  text (brief §5).
- Project identity comes exclusively from OpenCode's trusted `project.id` (plugin input): project
  A → store A, project B → store B. Tested: separate stores never leak state.
- Runtime instance ownership (`runtime/instance.ts`): `getProjectInstance(projectID)` keeps one
  durable instance per project id; the process-local in-memory singleton remains for tests only.

## Persistent Schema

`memory/document.ts` — versioned `StoreDocument` (schemaVersion 1): `runs`, `runOrder`, `events`,
`committed` (architecture/section/sectionRevision/decision records keyed `ID@REVISION`),
`proposals`, `approvals`, `commits`, `commitByProposal` (idempotency index), `snapshots`,
`evidence`. Record-keyed identities with validated JSON payloads for immutable content — identity,
revision, status, hash, and HEAD references are first-class document fields (§9). Only currently
implemented families exist; no speculative future tables.

## Durable vs Ephemeral State

- **Durable:** PlanningRun (stage/lifecycle/activeWork/goal/constraints/questions/conflicts),
  architecture/section/section-revision/decision revisions, proposals (frozen payload + hash +
  status + createdFrom), approvals, plan commits, snapshots, event log, evidence, HEAD pointers,
  ID allocation (derived from persisted records inside the write lock).
- **Ephemeral (tested):** StartAdmissions — restart invalidates unused admissions (fail-closed;
  a fresh `/ultra-plan` is required, §36); ObservationLedger — observations do not survive, so old
  observations cannot mint new direct evidence; promoted Evidence remains durable. An interactive
  `ToolContext.ask` prompt is not durable; recovery depends only on whether the Approval record
  was durably committed (§37).

## Schema Versioning

`STORE_SCHEMA_VERSION = 1`. On open: no file → create current schema; current version → open;
older → `store_corrupt` (no migration exists yet — none manufactured); **newer → fail closed**
`store_version_unsupported`; malformed JSON → fail closed `store_corrupt`. Never deletes,
downgrades, or recreates (§11/§38).

## Transaction Atomicity Mapping

Phase 2B1's engine is INHERITED — `DurablePlanStore extends InMemoryPlanStore`, so validation,
staging, change application, publication order, and idempotency are the same code (brief §27, no
duplicated business logic). The durable subclass wraps every mutating operation in `withLock`:

```text
acquire exclusive lock file (O_EXCL, bounded retry, stale theft)
  → reload authoritative state FROM DISK (revalidation binds to durable HEAD)
  → run inherited 2B1 mutation (engine validates + publishes in memory)
  → serialize document → temp file → fsync → ATOMIC RENAME (the durable commit point)
release lock
```

`publishTransaction` (2B1's seam) maps to one real durable operation: the rename swaps the entire
authoritative state at once; any crash before it leaves the previous file byte-identical.

## Concurrency Model

Cross-instance writer serialization via exclusive `O_EXCL` lock file: bounded wait (4 s default),
stale-lock theft (15 s), then `store_busy` — transient contention is distinguishable from
semantic invalidity (§32). Critically, every mutation RELOADS FROM DISK inside the lock before
running the engine, so writer B re-validates against the durable HEAD writer A moved: B fails
`head_snapshot_mismatch` instead of forking the chain (§15). Reads are per-instance cached;
the write path is the sole authority. Documented: no distributed locking — this is local plugin
storage.

## Persistent ID Allocation

IDs continue monotonically after restart because allocation derives from persisted records
(max+1) computed INSIDE the write lock — the explicitly allowed mechanism (§17). Tested: first
post-restart proposal is `PROP-001` when none existed, and never collides with pre-restart ids.

## Restart Recovery Semantics

All verified across real close/reopen cycles (§18/§29): active run + HEAD + committed artifacts
reload exactly; ready proposals stay ready; `awaiting_approval` without Approval stays awaiting
with NO fake approval and can be re-presented and approved after restart; `awaiting_approval`
with a durable Approval reloads the SAME immutable Approval and the commit may be retried with no
re-approval; already-committed proposals retry idempotently (same PlanCommit); rejected proposals
stay rejected and cannot commit.

## Crash Recovery

Real child-process crashes (`scripts/crash-probe.mjs`, `test/durable-crash.test.ts`):
- **before durable persist** (`process.abort()` at the seam): reopened store shows zero
  transaction mutation — no decision, no commit, HEAD unchanged, proposal still
  `awaiting_approval`, Approval still durable and retriable → the retry then commits cleanly.
- **after the atomic rename, before caller response**: reopened store contains exactly one
  committed transaction; the exact retry returns the SAME PlanCommit with zero duplicates.
Windows note captured in tests: `process.abort()` exits 134/signal-null and discards buffered
stderr, so assertions use the exit status + absence of the clean-commit marker.

## Proposal / Approval Recovery

Proposals persist the frozen payload, revision, hash, status, and `createdFrom`. On every store
open the document validation RECOMPUTES each stored proposal hash — a tampered/mismatched hash
fails closed (`store_corrupt`), and approvals are validated against their proposal's id/revision/
hash at load (§24/§38.5). Approvals are immutable; there is no update path.

## Commit / Snapshot / Event Durability

Events, Snapshot, and PlanCommit are written in the SAME document publication as the state they
describe — `transaction.committed`/`head.moved` can never exist without their commit/snapshot/HEAD
(§22). Event order survives restart (parity + restart tests assert sequence equality). Snapshots
are immutable and never rewritten; `getHeadSnapshot()` after reopen returns semantically identical
state (asserted).

## PlanStore Behavioral Parity

`test/parity-suite.ts` runs one contract suite against BOTH stores: run create/resume,
one-active-run invariant, exact evidence revisions, proposal freeze/read, approval persistence +
idempotency, commit success/rollback/idempotency, HEAD movement, snapshot reads, event order,
question resolution via commit only, section amendment reopen + `needs_review` propagation,
evidence exact reads, terminal lifecycle reads. 26 parity tests (13 × 2 stores), all green; no
intentional semantic differences. `InMemoryPlanStore` remains the fast unit-test oracle and
continues to pass the same suite.

## Corruption / Fail-Closed Behavior

Tested fail-closed paths: newer schema version; malformed JSON; HEAD → missing snapshot;
proposal hash that does not recompute. Additionally: duplicate exact revisions were already
rejected at the engine level; the document loader treats every reference break as `store_corrupt`
and never repairs, deletes, resets HEAD, or reconstructs from conversation (§20/§38).

## Production Runtime Wiring

`UltraPlanPlugin` now uses `getProjectInstance(input.project.id)` — the production plugin opens
the DurablePlanStore eagerly; a store that cannot open fails the plugin load loudly (no silent
in-memory fallback). `Hooks.dispose` closes the store. Startup order: derive project store
location → open/verify schema → recover state → construct controller → register hooks/tools.

## Tests Added

- `test/parity-suite.ts` + `test/durable-parity.test.ts` — 13-test contract suite × 2 stores
  (26 tests).
- `test/durable-restart.test.ts` — 13 tests: version gate, malformed/corrupt fail-closed, real
  reopen recovery of runs/proposals (ready/awaiting/rejected/committed)/approvals/decisions/
  evidence/events/snapshots/HEAD, ID-continuation, admission + observation ephemerality,
  concurrent writers (stale loss + idempotent same-transaction retry through a second instance).
- `test/durable-crash.test.ts` — 3 REAL child-process crash tests (before-persist, after-persist,
  clean control) via `scripts/crash-probe.mjs`.
- All pre-existing 104 OpenCode tests remain green, plus 2A.1's; total now **146** (12 files).

## Live OpenCode Restart Validation

**14/14 live checks passed** (`npm run smoke:opencode`), including the new §35 scenario:

```text
PASS  sessions survive the server restart — <same session ids restored>
PASS  /ultra-plan after a REAL server restart RESUMES the same durable PlanningRun (§35)
      — ultraplan_start executed (resume path); no PLAN-002 created
```

This crossed a genuine process boundary: server 1 killed (taskkill tree), a NEW `opencode serve`
process started over the same project, the same session re-driven through the real `/ultra-plan`
command → the same `PLAN-001` resumed from the durable store. The store file location for the
smoke is pinned into the fixture via `ULTRA_PLAN_DATA_DIR`. All 12 prior checks (plugin load,
config registration, tool surface, denied unauthorized start, create/resume, deterministic status,
single session) remain green, and the runtime tool list now includes
`ultraplan_request_user_approval`.

## Verification Results

OpenCode scope (this phase):

```text
npm run typecheck -w @switchboard/opencode → 0 errors
npm run lint      -w @switchboard/opencode → 0 problems
npm test          -w @switchboard/opencode → 12 files, 146/146 tests passed
npm run build     -w @switchboard/opencode → dist emitted (live smoke + crash probes run against it)
npm run smoke:opencode                     → 14/14 live checks passed
```

## Root Workspace Status

Root aggregate `npm run typecheck` / `lint` / `test` / `build`: **all green**. The previously
failing `adapters/claude-code` workspace has been repaired by its own concurrent workstream and
now passes (15 files / 141 tests) in the aggregate run. No root failures remain; nothing in that
workspace was touched by this phase.

## Deviations From Frozen Architecture

None new. The frozen architecture is persistence-agnostic ("durable plugin-owned structured
state", §12/§18 of the architecture); the JSON-document backend satisfies it without amendment.
Two documented carry-overs from earlier phases remain (natural-language constraints not machine-
validated at commit; conservative blocking-conflict scope intersection) — unchanged in 2B2.

## Risks / Open Issues

- Whole-document publication is O(state size) per write — correct and fast at planning scale
  (tens of artifacts); if a future phase stores very large histories, compact snapshots or a real
  embedded DB (verified in-host) would be the migration path. The `PlanStore` boundary keeps that
  a drop-in change.
- Cross-instance READS are per-instance cached between writes (documented; writes re-load under
  the lock, which is where correctness matters). A read-refresh API could be added if a multi-
  process dashboard ever needs it.
- `process.abort()` crash tests cover the commit boundary; crashes mid-`fsync` are covered by the
  same rename atomicity argument but were not individually fault-injected.
- The `seedCommittedState` test fixture throws on the durable class when called synchronously
  (must use `seedCommittedStateAsync`) — intentional friction so production code cannot silently
  seed durable state.

## Recommended Phase 2C Starting Point

Architecture Planning Workflow on the proven durable substrate: Discovery → architecture working
design via the existing proposal pipeline (`ultraplan_prepare_proposal` with architecture
changes) → `ultraplan_request_user_approval` → PlanCommit → `complete_architecture` →
deterministic `architecture → detail` transition. Everything this phase needs — durable
transactions, approval admission, capability gating — is already in place; no additional
persistence semantics should be introduced.
