# Phase 4 Implementation Note — PlanningRun & State Machine Foundation

Scope: how Phase 4 is implemented. Authority remains
`docs/claudecode/spec/claude-code-phase-plan-v0.1-architecture-spec.md`
(§7 PlanningRun model, §8 lifecycle, §38 error semantics); nothing here
amends it. Built on the frozen Phase 2 migration/backup framework and the
Phase 3 binding primitives.

## Schema v3 (migration `2 → 3 planning-run-foundation`)

```sql
CREATE TABLE planning_runs (
  run_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','completed','aborted')),
  stage TEXT NOT NULL CHECK (stage IN ('discovery','architecture','detail',
                                       'synthesis','validation','final')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  goal TEXT NOT NULL CHECK (length(trim(goal)) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (lifecycle != 'completed' OR stage = 'final')
);
CREATE INDEX idx_planning_runs_workspace ON planning_runs (workspace_id);
```

Exactly ONE new planning-domain table. No Architecture/Section/Decision/
Proposal/Plan-Memory tables and NO future ref columns (architecture_id,
head_commit, head_snapshot, handoff fields) — those arrive with their own
phases via further migrations.

## PlanningRun persisted shape

`run_id` (`plan_<uuid>`, opaque — never derived from path/session/workspace/
timestamp), permanent `workspace_id` (real FK; no move/rebind API exists),
`lifecycle`, `stage`, `revision`, `goal`, timestamps (Phase 2 clock seam).

## Lifecycle semantics

`active | completed | aborted`; completed/aborted are TERMINAL — no path
back to active. **Phase 4 represents `completed` structurally but exposes no
production transition into it**: the only legal completion path (Final
Approval → Final PlanCommit → handoff_pending → successful host handoff)
belongs to the handoff phase, and no generic `markCompleted()` exists to
bypass it. Aborted runs rest at their last valid stage forever.

## Stage graph and transition events

Pure core (`src/core/state-machine.ts`, no SQLite/Claude/MCP/fs/env):

```text
discovery    --DISCOVERY_COMPLETE-->    architecture
architecture --ARCHITECTURE_APPROVED--> detail
detail       --DETAIL_COMPLETE-->       synthesis
synthesis    --SYNTHESIS_SUBMITTED-->   validation
             --REOPEN_DETAIL-->         detail
             --REOPEN_ARCHITECTURE-->   architecture
validation   --VALIDATION_CLEAN-->      final
             --REOPEN_DETAIL-->         detail
             --REOPEN_ARCHITECTURE-->   architecture
final        --REOPEN_DETAIL-->         detail
             --REOPEN_ARCHITECTURE-->   architecture
```

Callers declare what happened; the machine decides the stage. Any
stage/event pair outside the matrix → `INVALID_RUN_TRANSITION`. BUILD and
handoff_pending are not stages. There is no final→completed transition.

## Revision semantics

`revision` starts at 1 and increments exactly once per authoritative run
mutation (stage transition, discovery-goal revision, abort). Mutations
require `expectedRevision`, re-verified inside the same `BEGIN IMMEDIATE`
transaction; mismatch → `STALE_RUN_REVISION`. **PlanningRun.revision is NOT
the future Plan Memory HEAD** — two concurrency domains will coexist.

## SessionBinding generation vs Run revision

Every run mutation requires BOTH: the exact current writable binding
generation (`assertWritableBindingInTx`) and the exact current run revision.
Generation protects the ownership epoch; revision protects the run-state
epoch. Neither substitutes for the other. Validation precedence is frozen
for determinism: run exists → workspace exact → binding/generation →
lifecycle active → revision → transition legality → apply. (Abort is one
documented deviation: its terminal check precedes the binding assert so an
idempotent retry lands on `RUN_TERMINAL`, never double-applied, per §35.)

## Run creation transaction

`createPlanningRun({workspaceId, sessionId, goal})` — ONE store transaction:
workspace exists (`WORKSPACE_NOT_FOUND`) → no attached binding for the
session, INCLUDING legacy opaque ones (`SESSION_ALREADY_BOUND`, fail-closed,
never silently cleaned) → insert run (active/discovery/1) → insert attached
binding generation 1 → commit. Binding failure rolls the run insert back; no
orphan runs.

## Reattach / takeover integration

`reattachActiveRun` / `takeoverActiveRun` load the run first and require:
run exists → exact workspace → `lifecycle == active` (`RUN_TERMINAL`
otherwise) — only then does the Phase 3 binding epoch change apply. Aborted
and completed runs can never reattach or change owner.

## Abort algorithm

`abortPlanningRun` — ONE transaction: run exists → workspace exact →
terminal (`RUN_TERMINAL`, also the idempotent-retry result) → writable
binding → expected revision (`STALE_RUN_REVISION`) → lifecycle=aborted,
revision+1, binding detached with generation+1 → commit. No
stale-writer window; the old owner is fenced immediately. Aborted runs keep
their rows forever (no deletion API).

## Legacy opaque binding handling

Schema-2 bindings without a planning_runs row are preserved as-is by the
migration — never deleted, converted, or fabricated into runs. Domain
queries treat them as runs only if a matching planning_runs row exists. A
legacy binding's attached session still blocks `createPlanningRun` with
`SESSION_ALREADY_BOUND`.

## Error codes

`RUN_NOT_FOUND`, `RUN_TERMINAL`, `INVALID_RUN_TRANSITION`,
`STALE_RUN_REVISION`, `INVALID_RUN_GOAL`, `RUN_STATE_INVALID` — in the
runtime error union, mapped to the Phase 3 `domainState = 6` exit family.
`STALE_RUN_REVISION` is deliberately distinct from
`STALE_SESSION_BINDING` so agents can distinguish "reload run state" from
"ownership lost".

## Schema v3 integrity validation

`validateSchemaV3` (inside `inspectSchemaState`) re-derives invariants from
DATA, not just `user_version = 3`: table presence, legal lifecycle/stage
values, revision ≥ 1, non-empty goals, completed→final, terminal runs hold
no attached binding, binding-vs-run workspace agreement (skipping legacy
opaque targets), and workspace FK validity.

## Concurrency behavior

Real multi-process tests (esbuild-bundled worker): same-session concurrent
creates → one run + one binding, loser `SESSION_ALREADY_BOUND`, no orphan;
same-revision concurrent transitions → one winner at revision N+1, loser
`STALE_RUN_REVISION`; abort-vs-transition race → exactly one winner and no
contradictory state (an aborted run never retains an attached binding).

## Intentional deferrals

Plan Memory/artifact model (Phase 5), HEAD Snapshot/Commit, Proposal/
Approval/PlanCommit, handoff_pending persistence and the completion
transition, HostContextEnvelope, SessionStart hook, Plan Mode transitions,
model-facing MCP tools (`tools/list` remains `[]`), run-selector UI,
command idempotency ledger, workspace path-liveness checks in the state
machine (the machine knows identity, not the filesystem).
