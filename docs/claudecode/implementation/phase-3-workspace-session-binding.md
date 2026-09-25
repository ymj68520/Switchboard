# Phase 3 Implementation Note — Workspace Identity, SessionBinding & Generation Fencing

Scope: how Phase 3 is implemented. Authority remains
`docs/claudecode/spec/claude-code-phase-plan-v0.1-architecture-spec.md`
(§23.2 identities, §23.8 ownership/fencing, §38 error semantics); nothing
here amends it. Built on the Phase 2 store/migration/backup framework
(`phase-2-plan-store.md`) — migration 1→2 rides the exact same runner,
backup, and rollback guarantees.

## RepositoryIdentity semantics

- A persistent, opaque, Phase-Plan-assigned ID (`repo_<uuid>`). It is NOT the
  path, name, branch, remote URL, or HEAD.
- `canonical_locator` = how THIS local storage domain currently identifies
  the repository:
  - git: the canonicalized **git common directory** (`git rev-parse
    --git-common-dir`) — stable across all linked worktrees of one clone;
  - directory: the canonical directory itself.
- Unique per store (`UNIQUE`), re-observed registrations reuse the ID and
  only refresh `last_seen_at`.

## WorkspaceIdentity semantics

- Persistent opaque ID (`ws_<uuid>`); the canonical root is the locator.
- `UNIQUE (repository_id, canonical_root)` — duplicate registrations are
  impossible at DDL level.
- Kinds: repository `git|directory`, workspace `git_worktree|directory`.
- Availability is NOT persisted: no `status = deleted/unavailable` lifecycle.
  A deleted workspace keeps its catalog rows; recovery decides availability
  at use time. Phase 3 never deletes identities or bindings.

## Git discovery algorithm

`discoverWorkspace(projectDir)` (`src/workspace/discovery.ts`):

1. canonicalize the project directory (below); non-existent/unreadable →
   `WORKSPACE_UNAVAILABLE`.
2. `git rev-parse --show-toplevel` then `--git-common-dir`, spawned with a
   fixed argv, `shell: false`, bounded timeout, captured stdout. No `which`,
   no shell parsing, no interpolation.
3. toplevel/common-dir missing (not a repo) or git unavailable → **directory
   fallback** (not an error). True anomalies (invalid path, canonicalization
   failure) surface explicitly.
4. Locators canonicalized: same physical workspace → same registration;
   different worktrees → different registrations; nested cwd resolves to the
   same toplevel; symlink aliases resolve via realpath.

Discovery accepts an explicit project directory (future `CLAUDE_PROJECT_DIR`
wiring); the runtime cwd is never used implicitly.

## Path canonicalization

One abstraction (`src/workspace/canonical-path.ts`): `path.resolve` →
`fs.realpathSync` (symlink aliases + true on-disk casing) → strip trailing
separator (roots keep theirs). Comparison keys lowercase **only on win32**;
no blanket Unix-style lowercasing. Case behavior is centralized here.

## Schema v2 (migration `1 → 2 workspace-and-session-binding`)

```sql
CREATE TABLE repositories (
  repository_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('git','directory')),
  canonical_locator TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE workspaces (
  workspace_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(repository_id),
  kind TEXT NOT NULL CHECK (kind IN ('git_worktree','directory')),
  canonical_root TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (repository_id, canonical_root)
);
CREATE TABLE session_bindings (
  run_id TEXT PRIMARY KEY,            -- opaque future PlanningRun ID (§3)
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  session_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('attached','detached')),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_session_bindings_active_session
  ON session_bindings (session_id) WHERE state = 'attached';
```

No PlanningRun/state/stage tables — `run_id` is a writable-ownership target
only; Phase 4 decides on constraint rebuild vs application-level run
existence. Existing schema-1 stores migrate with the Phase 2 consistent
backup (`phase-plan-pre-schema-1-2-…`); a failing v2 migration rolls back to
a fully valid schema-1 store. `SUPPORTED_SCHEMA_VERSION = 2`; a real
schema-1 writer (runWrite with the old binary's floor) is fenced with
`STORE_SCHEMA_TOO_NEW` after migration — the production version of Phase 2's
E17, no user_version manipulation.

## SessionBinding schema & invariants

SB-01 one run → one binding row (PK `run_id`); SB-02 one session → at most
one ATTACHED binding (partial unique index); SB-03 exact-workspace scoping
(every operation compares `workspace_id`, `WORKSPACE_MISMATCH` otherwise);
SB-04 generation monotonic (CHECK + single `generation = generation + 1`
update path); SB-05 every ownership change is one store write transaction;
SB-06 stale generations fail `STALE_SESSION_BINDING`. A schema validator
(`validateSchemaV2` inside `inspectSchemaState`) re-derives the invariants
from DATA — table presence, generation bounds, state values, duplicate
attached sessions, orphan workspaces/bindings — instead of trusting
`user_version = 2`.

## Generation semantics

`generation` is the writable-ownership EPOCH, not a takeover counter:
initial bind = 1; detach, reattach, and takeover each increment by exactly
one. It never decreases, resets, or reuses; all previous authority dies with
the epoch change.

## Detach / reattach

Detach (owner-only, `STALE_SESSION_BINDING` otherwise) flips attached→
detached, keeps run/workspace/session rows (so exact-session `/resume` can
find the run later), and bumps the generation. Reattach requires ALL of:
detached state + exact same session + exact same workspace (`WORKSPACE_
MISMATCH` on drift, never an automatic rebind) → attached with a new
generation. A session that merely finds a similar repository/workspace is
NEVER auto-bound.

## Takeover algorithm

`takeoverBinding({runId, newSessionId, workspaceId, expectedGeneration})` —
internal application primitive (`src/session/binding-service.ts`); no
model-facing MCP tool exists (future `phase_plan.takeover_run` calls this
after formal human authorization). Inside one write transaction: load
binding → verify workspace → compare `expectedGeneration` → verify the new
session owns no other attached run → swap session/state and increment
generation → commit. The old owner is permanently fenced. NO liveness
detection of any kind (no PID/heartbeat/lease/timeout) participates.

## Writable-binding assertion

`assertWritableBinding({runId, workspaceId, sessionId, generation})` is the
boundary every future mutation must pass: exact match on all five facts or a
stable code (`BINDING_NOT_FOUND`, `WORKSPACE_MISMATCH`, `BINDING_DETACHED`,
`STALE_SESSION_BINDING`).

## Concurrency model

SQLite is the only coordinator: `BEGIN IMMEDIATE` serialization + in-
transaction re-reads + unique constraints. Registration, competing binds,
and same-generation takeovers are proven with REAL multi-process tests
(esbuild-bundled workers, 3 concurrent registrars / 2 competing binders / 2
competing takeovers) — exactly one winner per conflict, deterministic codes
for losers, final generation = expected + 1 (never +2).

## Error codes

`WORKSPACE_NOT_FOUND`, `WORKSPACE_UNAVAILABLE`, `WORKSPACE_MISMATCH`,
`SESSION_ALREADY_BOUND`, `RUN_ALREADY_BOUND`, `BINDING_NOT_FOUND`,
`BINDING_DETACHED`, `BINDING_CONFLICT`, `STALE_SESSION_BINDING` — declared in
the runtime error union and mapped to a new centralized exit family
(`domainState = 6`); no CLI surface emits them yet, but error→exit stays
total and tested.

## Known limitations

- **Caller authentication is deferred: Phase 3 implements binding
  persistence and fencing, while future HostContext integration supplies
  authoritative Claude session identity.** sessionId is opaque equality
  compared, entering only through the internal application/test API.
- No model-facing MCP tools were added; `tools/list` remains `[]`.
- Doctor and MCP bootstrap are unchanged (Phase 3 adds no registration or
  binding behavior at startup; future SessionStart // /phase-plan workflows
  trigger it).

## Phase 4 boundary

PlanningRun lifecycle/state machine, Architecture/Section/Decision domain,
Proposal/Approval/PlanCommit, HostContextEnvelope, hooks, observation
evidence, and context assembly stay out of Phase 3.
