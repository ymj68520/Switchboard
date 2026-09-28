# Phase 16 — PlanningRun ownership control & explicit abort (takeover_run / abort_run)

Status: IMPLEMENTATION COMPLETE + LIVE CLOSURE COMPLETE WITH ONE DOCUMENTED
HOST BLOCKER (`ARCHITECTURE_BLOCKER_ABORT_HOST_AUTH_MODE_TRANSITION`, §38/§40
probe result — see the validation record). Frozen baseline: Phase 15
(`332df97` + `75fe3d3` + `a237588` + `6e9c08a` + `b80db6c`).

## Schema v13 (`013-run-control-authorizations`)

One new durable, append-only authority table — no control state machine:

```
run_control_authorizations(
  control_id TEXT PRIMARY KEY,          -- ctrl_<uuid>
  run_id, operation CHECK (IN ('takeover','abort')),
  authorization_request_id TEXT UNIQUE, -- mcp-control:<signed toolUseId>
  operation_id TEXT UNIQUE,             -- takeover:<toolUseId> / abort:<toolUseId>
  request_hash,                         -- sha256 over {operation, run_id, workspace_id, expected_binding_generation}
  workspace_id,
  expected_binding_generation, resulting_binding_generation,
  previous_binding_identity, new_binding_identity,   -- takeover lineage (JSON, internal-only)
  resulting_run_revision, reason,                     -- abort lineage
  created_at,
  FOREIGN KEY (run_id) REFERENCES planning_runs(run_id))
+ no_update / no_delete triggers (§5) + (run_id, operation) index
```

`operation_id` is the idempotency identity (§25/§53): the SAME authorized
invocation retrying after a crash finds its row and replays `idempotent: true`
without re-applying; the same operation id with a different `request_hash` is
`IDEMPOTENCY_CONFLICT`. Session identities are persisted for audit but never
returned to the model (§4/§13). No backfill — the table starts empty (§52).

`validateSchemaV13` (bounded, store-open): run exists + workspace matches,
operation vocabulary, takeover/abort lineage shows
`resulting = expected + 1` (the only legal ownership step), abort's
`resulting_run_revision` is one the run actually reached, identity uniqueness,
immutable triggers present. No binding-history replay (§51).

## §7 audit — the frozen primitives were already complete

Phase 3 shipped everything Phase 16 composes; no second ownership path was
written:

- `takeoverBindingInTx(expectedGeneration)` — the ONLY G → G+1 ownership
  change, with same-workspace and `SESSION_ALREADY_BOUND` fences
  (`store/session-bindings.ts`);
- `detachBindingInTx` — the abort detach (epoch change, generation +1);
- `assertWritableBindingInTx` — the exact-owner/exact-generation gate;
- `"aborted"` was already in the frozen lifecycle vocabulary with terminal
  semantics (`core/state-machine.ts`, `isTerminalLifecycle`);
- the run-control service (`application/run-control-service.ts`) composes
  these with the durable authorization inside ONE `BEGIN IMMEDIATE`
  transaction per §17/§35.

## takeover_run contract (§8–§26)

- Input: `{run_id, expected_binding_generation}` ONLY — the generation is a
  stale precondition, never authority; server authority is the signed
  HostContext + Store. Model-supplied workspace/session/force fields are
  rejected by the exact-business-field gate.
- Target: ACTIVE runs only — completed/aborted → `RUN_TERMINAL` (§8/§9).
- `TAKEOVER_NOT_REQUIRED` when the caller already owns the binding (§22 —
  the exact-session reattach path stays `start_or_resume`).
- Caller conflict: an attached planning OR execution binding on the caller →
  `SESSION_ALREADY_BOUND` (§15/E11/E12) — authority is never silently swapped.
- Handoff boundary: any `execution_handoffs` row or `execution_bindings` row
  for the target → `TAKEOVER_NOT_AVAILABLE_DURING_HANDOFF` (§10).
- One transaction: insert authorization → epoch change → commit. Concurrent
  takeovers serialize on `BEGIN IMMEDIATE`; exactly one winner, losers fenced
  `STALE_SESSION_BINDING` (§26/E23). Writers that lost a SessionEnd race
  carry a stale expected generation and fail closed (§57).
- The run row is untouched: revision/stage/HEAD/Proposals/Evidence carry over
  exactly; no new PlanningRun; result status is `taken_over` (§18/§21).
- Old-owner fencing is immediate and does not depend on liveness: after the
  epoch change the old session's next mutation lands on
  `STALE_SESSION_BINDING`/detached-binding refusal even with the old process
  alive (§19/§24/E22/E67 — proven live).
- Selection metadata (§13): `selection_required` now returns goal, binding
  state + generation, and HEAD summary per candidate — never another
  session's session id, host-context data, or plugin paths (§45: candidates
  are active runs only; aborted runs never cause `RUN_SELECTION_REQUIRED`).

## abort_run contract (§27–§42)

- Input: `{reason?}` at most; the reason is an audit note and never affects
  legality (§27). The target is the caller's OWN attached active run — the
  model cannot name one (§28).
- One transaction (§35): exact writable owner (attached + exact generation) →
  active → no handoff ownership (`ABORT_NOT_AVAILABLE_DURING_HANDOFF`, §34) →
  insert authorization → `lifecycle active → aborted`, `revision +1` exactly
  once → detach binding, `generation +1` exactly once.
- Terminal semantics: `aborted` never leaves (§29); a second DIFFERENT
  invocation fails closed (`STALE_SESSION_BINDING` — the binding is already
  detached); the SAME invocation replays idempotently (§25/§53).
- History is preserved wholesale (§31): Proposals (including awaiting),
  Approvals, PlanCommits, Snapshots, Plan Memory, Evidence, validation and
  synthesis history, audit, workflow history all stay immutable; an awaiting
  proposal survives as a frozen artifact that can never be committed.
- No Build authority (§32/§33): no FinalPlan/handoff/ExecutionBinding is
  created; an approved FinalPlan from before the abort remains unused
  immutable history; `phase_plan.handoff` afterwards is refused by the
  binding fence.
- Post-abort reads: the aborted run is nobody's current run (planning reads
  return `no_active_run`); `get_context(detail=build)` under planning
  authority is refused `EXECUTION_CONTEXT_NOT_AVAILABLE` (§66 — the Execution
  Contract projection exists only under delivered-handoff execution
  authority); harmless host tools keep working. SessionStart never reattaches
  (terminal runs cannot reattach); a later `/phase-plan` creates a NEW
  ordinary run — never a Phase 15 successor (no FinalPlan baseline, §43).
- SessionEnd after abort is idempotent — the abort already detached, so the
  SessionEnd loop finds only a detached row and does not bump again (§69).

## Mandatory human interaction

Both tools carry `anthropic/requiresUserInteraction: true` (real JSON
boolean); the PreToolUse hooks return `ask` with the signed V2 context and
NEVER `allow`; the PermissionRequest hook never auto-allows takeover (the
dialog IS the authorization). V2 agent attestation denies subagents
(`VALIDATOR_MUTATION_FORBIDDEN`, §46/§47); execution-domain tokens fail
HMAC verification before any store access (§52).

## Abort authorization + mode transition — the §38 host probe

The desired chain: mandatory dialog → Yes → `setMode(default, session)` →
handler. The PermissionRequest hook re-verifies the FULL authorization facts
from the Store (signature → session/prompt binding → run active → exact
writable generation → no handoff state) and only then returns
`allowWithPermissions([{type:"setMode", mode:"default", destination:"session"}])`
— the same shape the frozen `start_or_resume` plan-mode entry uses.

Live probe result (Claude Code 2.1.283, real TUI, see the validation record):

- A. mandatory dialog: YES — appears even when the hook returned allow.
- B. `setMode(default, session)` applied after Yes: **NO** — the hook returns
  the documented payload (debug log verbatim) but the host drops
  `updatedPermissions` for `requiresUserInteraction` tools; the session stays
  in effective plan mode (write probe refused; status line unchanged).
- C. handler only after authorization: YES.
- D. deny → handler never executes, zero mutation: YES.

Per §40 this is reported as `ARCHITECTURE_BLOCKER_ABORT_HOST_AUTH_MODE_TRANSITION`
and NOT worked around (no settings writes, no bypassPermissions, no fake
approval, no raw DB mutation, no silent auto-allow). The abort remains fully
safe and human-authorized; only the mode-exit leg (E43/E71) is blocked on the
host.

Live-found adapter fix: the plugin `PermissionRequest` matcher did not yet
match the new tool names, so the hook silently never fired (`fix(claude)`
commit + assets-test pin asserting the regex matches all five host tool
names).

## Races (§57–§59)

Serialized writers make the fence the arbiter: takeover-vs-takeover → one
winner; takeover-vs-old-owner-mutation → old owner fenced; takeover vs
SessionEnd → the stale expected generation loses; abort-vs-mutation → the
mutation is refused the moment abort lands; abort-vs-approval → approval
first lands its commit and abort then runs on the NEW revision (the abort
service re-reads the run inside its transaction), abort first terminates the
run and approval fails closed with no PlanCommit after abort; abort-vs-
takeover → exactly one consistent outcome, dual ownership impossible.

## Why the deliberately-absent things stay absent

- No liveness/heartbeat oracle (§24/E22): fencing is the correctness
  mechanism; an attached live owner can be taken over.
- No execution-binding takeover (§9/E62): completed+delivered runs are
  terminal; `BUILD` ownership is out of scope forever.
- No execution progress (E61): no steps, no task states, no percent done —
  control-plane only.
- No run deletion / restart / cross-workspace migration.
- `approve_proposal` still belongs to design authorization only; control
  operations have their own durable authority (§3).
