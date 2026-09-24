# Phase 2 Implementation Note — SQLite Plan Store Foundation

Scope: how the Plan Store substrate is actually implemented. Authority remains
`docs/claudecode/spec/claude-code-phase-plan-v0.1-architecture-spec.md`
(§25 storage, §26 runtime binding, §28.4 no daemon); nothing here amends it.
Phase 1 baseline is frozen and untouched except for additive doctor/MCP
integration described below.

## Physical database location

```text
${CLAUDE_PLUGIN_DATA}/store/phase-plan.sqlite3
```

Layout resolution lives in `src/store/paths.ts` (`resolveStorePaths`) —
backups/, blobs/, exports/ keep their Phase 1 directories. No production code
hardcodes user paths; tests use temp plugin-data roots.

## Schema version authority

`PRAGMA user_version` is the ONE authoritative schema version
(`SUPPORTED_SCHEMA_VERSION = 1`). `schema_migrations` is an audit history,
never a second authority: rows must be exactly 1..N for user_version N or the
store is `STORE_SCHEMA_INVALID` (never auto-repaired). Plugin version, schema
version, and `protocol_version` (store metadata, currently 1) are distinct
concepts.

## Schema v1 (complete)

```sql
CREATE TABLE store_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  store_id TEXT NOT NULL UNIQUE,
  protocol_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  runtime_version TEXT NOT NULL
);
PRAGMA user_version = 1;
```

No indexes beyond the implicit primary keys; no planning-domain tables (those
arrive as future migrations `1 → 2`, …). `store_id` is generated once at
first initialization (injectable id seam) and stable across reopen.

## PRAGMA policy (every production connection, one place)

`src/store/connection.ts` `openDatabase()`:

```text
PRAGMA busy_timeout = 5000   (STORE_BUSY_TIMEOUT_MS; installed FIRST so all
                              later statements honor the bounded wait)
PRAGMA journal_mode = WAL    (skipped when already WAL; bounded retry absorbs
                              a concurrent DELETE→WAL conversion by another
                              process — never unbounded)
PRAGMA synchronous = FULL
PRAGMA foreign_keys = ON
PRAGMA user_version (probe)  header check → junk files fail STORE_CORRUPT at
                             open, deterministically
```

Read-only connections skip WAL/synchronous mutation but still probe the
header. Tests read the actual PRAGMAs through a live connection and assert
`journal_mode=wal`, `synchronous=2`, `foreign_keys=1`, `busy_timeout=<value>`.

## Connection ownership

All `DatabaseSync` construction goes through `openDatabase`. `SqlitePlanStore`
owns one connection; `close()` is idempotent and post-close use fails with
`STORE_OPEN_FAILED`. The MCP bootstrap closes the store deterministically in
a `finally` once serving stops. No GC/finalizer/exit reliance.

## Transaction semantics

`withWrite` (`src/store/transaction.ts`) is the only mutation entry point:
`BEGIN IMMEDIATE` → **re-read `PRAGMA user_version` inside the reservation**
(schema fence) → operation → `COMMIT`; any failure `ROLLBACK`s.
`BEGIN`→`SQLITE_BUSY` maps to `STORE_BUSY` (bounded). `withRead` wraps a
`BEGIN DEFERRED` snapshot. Domain code never issues raw BEGIN/COMMIT.

## Migration registry and runner

Ordered one-step chain (`from → to = from+1`), validated for gaps/duplicates
at registration; the registry must reach exactly `SUPPORTED_SCHEMA_VERSION`.
Runner choreography: fast-path version read → `BEGIN IMMEDIATE` → **re-read
version inside the transaction** (a concurrent initializer may have won; then
it is a no-op commit) → backup (existing databases only) → apply pending
migrations + insert history rows → set `user_version` → validate schema state
inside the transaction → `COMMIT`. Any failure rolls back completely; source
stays at the old schema; the backup remains as a recovery artifact. SQLite
locking is the only coordinator — no lock/PID files.

## Backup algorithm

`node:sqlite` module-level `backup()` — never filesystem copies of the db or
its sidecars. Two implementation constraints were verified against Node
24.21.0 and drive the design:

1. `backup()` refuses to run on a connection holding an open write
   transaction. The runner therefore snapshots via a **second, idle
   connection** while the store connection holds the writer reservation —
   WAL readers get the last committed snapshot, and the reservation
   guarantees no writer can slip between the backed-up state and the
   migration commit.
2. A read-only open of the backup copy creates `-shm`/`-wal` litter (and a
   raw rename would separate a WAL from its main file). The pending copy is
   therefore checkpointed (`wal_checkpoint(TRUNCATE)` + clean close) and
   validated through a read-write connection, so the published backup is one
   self-contained file whose bytes are exactly the validated state.

Publication is two-phase: write to `backups/.pending-<name>` → validate
(open + `integrity_check` = ok + schema version match) → `fs.rename` to the
final name. Failures remove the pending file; a failed backup can never
masquerade as a valid one. No retention/GC (later policy work).

Naming: `phase-plan-pre-schema-<from>-<to>-<YYYYMMDDTHHMMSS>-<uuid>.sqlite3`
(deterministic given the injected clock/id seams).

## Schema fencing

- `current == 1` → writes allowed.
- `current > 1` → `STORE_SCHEMA_TOO_NEW`, fail closed, database untouched; no
  downgrade/reset/delete/recreate path exists anywhere.
- `current < 1` → business writes fail `STORE_SCHEMA_TOO_OLD`; only the
  initialization path may migrate.
- `inspectPlanStore` never writes: statuses absent / uninitialized / ready /
  too_new / too_old / invalid (newer-than-binary takes precedence over
  history consistency). `openPlanStore` is the strict old-process entry that
  refuses any drift. A deliberate failing migration (injected registry)
  proves full rollback; a legacy schema-0 database is backed up before
  migration even though v0.1 has no real legacy data.

## Corruption / invalid behavior

Non-SQLite files fail `STORE_CORRUPT` at open (header probe) and are never
deleted or recreated. Note: SQLite treats files shorter than 100 bytes as
empty databases; the doctor and open paths surface whatever SQLite actually
reads. History ↔ `user_version` disagreement is `STORE_SCHEMA_INVALID`.
Unwritable paths map to `STORE_OPEN_FAILED`.

## Doctor / MCP integration (additive to Phase 1)

- **Doctor** adds a read-only `Plan Store` check rendered between plugin
  data and the overall verdict: `STORE ABSENT` (NOT_INITIALIZED,
  non-blocking), `STORE READY schema=1`, `STORE TOO_NEW` / `STORE INVALID`
  (FAIL, exit 5). The doctor never creates or migrates the store; the JSON
  report gains one additive `checks.planStore` key (schema id unchanged).
- **MCP** now requires storage before serving: missing
  `CLAUDE_PLUGIN_DATA` → `PLUGIN_DATA_UNAVAILABLE` (no cwd/temp fallback);
  preflight failure, store too new, corrupt, migration or backup failure →
  fail closed with the stable code; only a ready store starts the server.
  `tools/list` remains `[]` — no model-facing domain tools.

## Test strategy

47 store-focused tests plus the extended dispatch/doctor/MCP suites
(141 total, all green on Node 22.23.2 and 24.21.0): registry validation,
fresh initialization, reopen/store_id stability, double initialization,
deterministic close, injected clock/ids, pre-migration backup + sentinel
preservation, injected backup/backupFn/migration failures with no partial
state, schema fencing (old process vs newer store, too-old writes), PRAGMA
verification on live connections, busy mapping with bounded wait,
reader-during-writer WAL snapshot, serialized writers, corruption/invalid
inspection matrix, and a REAL multi-process test: three bundled worker
processes concurrently initializing one schema-0 database → one migration
history row, one published backup, one shared store_id, integrity ok. MCP
bundle smokes inject a temp `CLAUDE_PLUGIN_DATA` (happy path, missing-env,
too-new store).

## Intentional deferrals (Phase 3+)

SessionBinding/binding generation/takeover fencing, WorkspaceIdentity,
PlanningRun/domain tables and repositories, HostContextEnvelope, Plan Mode
hooks, domain MCP tools, blob store content-addressing, exports, backup
retention/GC, protocol negotiation.
