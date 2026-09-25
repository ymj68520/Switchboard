# Phase 6 Implementation Note — Proposal / Approval / PlanCommit Transaction Engine

Scope: how the first authorized committed-memory write path is implemented.
Authority remains `docs/claudecode/spec/claude-code-phase-plan-v0.1-architecture-spec.md`;
nothing here amends it. Built directly on the Phase 5 memory model (migration
`4 → 5`), the Phase 4 PlanningRun state machine, and the Phase 3 binding
primitives.

## The headline

> **Phase 6 establishes the first authorized committed-memory transaction
> engine, but no runtime path can yet claim that Claude Code obtained real
> user authorization. The future `requiresUserInteraction` MCP handler is the
> sole production bridge into the authorization seam.**

`commitAuthorizedProposal(UserApprovalAuthorization)` is an internal seam
with NO production caller in this phase. There is deliberately no
`approved: boolean`, `isTrusted`, or `force` parameter anywhere, and no
natural-language approval judgment (§74) — a static import-boundary test
enforces all three.

## Schema v5 (migration `4 → 5 proposal-approval-plan-commit`)

New tables (all through the existing registry → `BEGIN IMMEDIATE` →
consistent-backup → apply → in-tx validation → COMMIT machinery):

```sql
proposals          (run_id, proposal_id) PK, prepare_request_id UNIQUE
                   (partial, NULL-exempt), prepare_request_input_json
proposal_revisions (run_id, proposal_id, revision) PK, proposal_type CHECK
                   (5-value frozen vocabulary), scope/title/summary,
                   changes_json, dependencies_json, impact_json,
                   base_run_revision, base_head_snapshot_id,
                   base_head_commit_id, canonical_json, proposal_hash
                   CHECK LIKE 'sha256:%'
                   CHECK (both base refs NULL or both NOT NULL)
                   composite FKs → plan_snapshots and plan_commits
proposal_states    (run_id, proposal_id, revision) PK, status CHECK
                   (awaiting_approval | approved | rejected | superseded)
approvals          approval_id PK, composite FK (run_id, proposal_id,
                   proposal_revision) → proposal_revisions, proposal_hash,
                   actor CHECK (actor = 'user'), authorization_request_id
                   UNIQUE
plan_commits       commit_id PK, UNIQUE(run_id, sequence), one root per run
                   (partial unique), one child per parent (partial unique),
                   composite FKs to proposal revision / approval / snapshots
audit_events       event_seq AUTOINCREMENT PK, event_id UNIQUE, event_type
                   CHECK (PROPOSAL_PREPARED | PROPOSAL_REVISED |
                   PROPOSAL_REJECTED | PLAN_COMMITTED)
plan_heads         UPGRADED: (run_id, head_snapshot_id, head_commit_id) —
                   legacy schema-4 rows are preserved with head_commit_id
                   NULL; never fabricated into commits
```

Database-level guarantees (Application layers add the rest):

- `proposal_revisions`, `approvals`, `plan_commits`, `audit_events` are
  immutable via `BEFORE UPDATE/DELETE` triggers (raw-SQL negative tests).
- `proposal_states` trigger: revisions START as `awaiting_approval`;
  terminal statuses are immutable; only awaiting →
  approved/rejected/superseded is a legal target.
- `approvals` hash-match trigger: `proposal_hash` must equal the frozen
  revision's stored hash, on top of the exact composite FK.
- `plan_heads` pair triggers: `head_commit_id != NULL` requires the commit's
  `resulting_snapshot_id == head_snapshot_id`.
- One awaiting proposal revision per run (partial unique index, §10).

## Proposal identity / revision / state

Three separate concerns (§6–§8): identity `(runId, proposalId)` where
`proposalId` is opaque and server-generated (`PROP-…` from the injected id
seam — never model text, timestamps, or scope paths); frozen revisions with
strict max+1 (no gaps, no reuse, immutable content + hash); per-revision
lifecycle state with terminal approved/rejected/superseded. `reviseProposal`
supersedes @N and freezes @N+1 in ONE transaction; authorizing a superseded
revision fails `PROPOSAL_SUPERSEDED` even with a perfectly correct hash.

## ProposalChange vocabulary (§13)

Typed domain operations only — never SQL, JSON patches, or row mutations:
`ADD_CONSTRAINT`, `SUPERSEDE_CONSTRAINT`, `ADD_DECISION`,
`SUPERSEDE_DECISION`, `SET_ARCHITECTURE_REVISION`, `SET_SECTION_REVISION`,
`ADD_OPEN_QUESTION`, `RESOLVE_OPEN_QUESTION`, `ADD_CONFLICT`,
`RESOLVE_CONFLICT`. Raw input never carries artifact ids, result revisions,
or `supersedes`/`resolvedBy` declarations — the server derives all of them
during normalization (§14): new ids continue the base world's numbering
(`DEC-2` after `DEC-1`), result revisions are previous+1, supersession is
derived from the exact base target, and section contracts are rebound to the
derived (sectionId, revision). One effective change per artifact per
proposal; candidate section DAGs (changed sections with real edges, unchanged
base sections as stubs) are validated before freeze (§17).

## Canonical representation and hash (§22–§24)

`ProposalCanonicalV1` (`src/core/proposal-canonical.ts`): schema/version
marker, runId, proposalId, proposalRevision, type, scope, baseRunRevision,
baseHeadSnapshotId, baseHeadCommitId, title, summary, normalized changes,
dependencies, impact. Timestamps, approval ids, commit ids, and status are
excluded — not design semantics. Hash = `sha256:` + lowercase hex over
`canonicalJson(canonical)` (sorted keys, compact). The hash is always
server-generated; authorization callers may only echo
`(proposal_id, proposal_revision, proposal_hash)` and the engine reloads the
authoritative revision, re-verifies the echoed hash AND re-derives the
stored hash from stored canonical JSON — a body+hash pair is never believed.
Array order is semantic for `changes` (application order); dependency and
impact sets are deduplicated and deterministically sorted at freeze.

## prepare / revise semantics (§16/§26/§81–§83)

`prepareProposal` freezes working design into an `awaiting_approval`
proposal: a WORKING-STATE mutation with zero committed-memory writes (pinned
by table-count assertions across memory_artifacts/revisions/snapshots/heads/
commits). Gate precedence is deterministic: run exists → workspace exact →
writable binding generation → run active → expected run revision →
proposal-type availability (`PROPOSAL_TYPE_UNAVAILABLE` for
section_completion/final_plan) → stage/scope capability
(`CAPABILITY_NOT_AVAILABLE`; architecture stage ⇒ architecture scope,
detail stage ⇒ section scope, architecture_completion refused at detail) →
legacy uncommitted HEAD (`MEMORY_HEAD_UNCOMMITTED`) → normalization +
candidate simulation → one-awaiting-per-run (`PROPOSAL_ALREADY_AWAITING`) →
apply. Prepare never increments PlanningRun.revision (§82). Prepare-request
idempotency (§83): same `prepareRequestId` + same raw input returns the SAME
proposal; same id + different input → `IDEMPOTENCY_CONFLICT`.

`rejectProposal` is internal working-state mutation only — no user-facing
reject tool exists in Phase 6; deny/cancel UIs (§29) never call it, so
denied proposals simply stay `awaiting_approval`.

## Approval persistence and the authorization seam (§30–§34)

Approval rows are immutable and bound to the EXACT frozen revision by
composite FK + hash-match trigger; `actor` is hardcoded `'user'` at the
database. Approval and PlanCommit are persisted in the SAME transaction —
a commit validation failure leaves no approval row (§34), because the
proposal must be re-authorized against whatever state made it stale.

## PlanCommit model, chain, HEAD (§35–§39/§48–§49)

Every commit: opaque server-generated `commit_id` (CMT-…), per-run
`sequence` (root 1, next = parent+1, `UNIQUE(run_id, sequence)`), parent +
base snapshot NULL only for the root, `resulting_snapshot_id` NOT NULL. The
database forbids two roots per run and two children per parent; the
authoritative linear-history protection is HEAD compare inside the engine's
single write transaction. Every successful commit creates exactly one new
immutable Snapshot — even with zero changes (`architecture_completion`
closure commits). First commit works from a null HEAD. Chain reads
(`getPlanCommit/getHeadCommit/listPlanCommits/getCommitChain`) order by
sequence; the explicit chain validator (§68) checks root shape, parent
linkage, base-snapshot linkage, and HEAD consistency at commit/test time —
never as a store-open scan.

## The commit transaction (§40/§41)

`BEGIN IMMEDIATE` (schema fenced in-tx by `withWrite`) → idempotency lookup
→ run exists → workspace exact → binding generation → lifecycle active →
run revision vs proposal base → proposal identity/state (superseded →
`PROPOSAL_SUPERSEDED`; approved → `PROPOSAL_ALREADY_COMMITTED`) → hash
verify + re-derive → HEAD/base equality (legacy snapshot-only HEAD →
`MEMORY_HEAD_UNCOMMITTED`) → dependencies exact/current → re-simulate
candidate → proposal-type gates → apply frozen changes through the Phase 5
internal writer → new Snapshot → Approval → PlanCommit → HEAD pair move →
proposal state → approved → State Machine side effect → audit. Any failure
rolls back everything.

## Type behaviors

- `design_checkpoint`: changes > 0 required; HEAD moves; PlanningRun
  revision/stage untouched (two concurrency domains, §50/§77).
- `amendment`: identical behavior; reopen must go through the State Machine
  before preparing (§51).
- `architecture_completion`: candidate must contain exactly one
  architecture; open blocking architecture-scoped questions →
  `BLOCKING_QUESTION`, open hard (blocking) conflicts → `BLOCKING_CONFLICT`,
  each with zero committed mutation; on success `ARCHITECTURE_APPROVED`
  transitions architecture → detail AND bumps PlanningRun.revision exactly
  once, in the same transaction (§54/§78); empty change sets are legal
  (§55).
- `section_completion` / `final_plan`: `PROPOSAL_TYPE_UNAVAILABLE` — never
  approximated (§56).

## Idempotency (§60–§63)

`authorizationRequestId` is the caller operation identity. Same id + same
(proposal, revision, hash) → idempotent replay returning the SAME
approval/commit/snapshot, `idempotent: true` — verified with REAL two-process
races (both processes succeed, one records, exactly one `idempotent: false`).
Same id + different semantics → `IDEMPOTENCY_CONFLICT`. Two different
request ids racing one awaiting proposal → exactly one commit, loser gets
`PROPOSAL_ALREADY_COMMITTED` after acquiring the writer lock (chosen over a
separate `PROPOSAL_ALREADY_COMMITTED`-vs-`PROPOSAL_NOT_AWAITING_APPROVAL`
split; the single stable code is test-pinned).

## Audit log (§69–§71)

`audit_events` is append-only (triggers), ordered by `event_seq`, with
`PROPOSAL_PREPARED`/`PROPOSAL_REVISED`/`PROPOSAL_REJECTED`/`PLAN_COMMITTED`
events; `PLAN_COMMITTED` fully references approval, commit, snapshot, and
the committed refs. Audit is provenance, NOT authority — the store is never
rebuilt from it.

## Internal committed-writer boundary (§75/§76)

Phase 5's raw writer primitives (`insertArtifactIdentityInTx`,
`insertMemoryRevisionInTx`, `insertSnapshotInTx`, `setHeadSnapshotInTx`) now
have exactly ONE production caller: `plan-commit-engine.ts`. A static
import-boundary test fails if any other production module imports
plan-memory.ts or re-exports the InTx primitives, and fails if
`makeTestUserAuthorization` (which lives only under `test/`) appears in any
production module.

## Error codes added

`PROPOSAL_NOT_FOUND`, `PROPOSAL_SUPERSEDED`, `PROPOSAL_HASH_MISMATCH`,
`PROPOSAL_NOT_AWAITING_APPROVAL`, `PROPOSAL_ALREADY_COMMITTED`,
`PROPOSAL_ALREADY_AWAITING`, `PROPOSAL_TYPE_UNAVAILABLE`,
`PROPOSAL_INVALID`, `CAPABILITY_NOT_AVAILABLE`, `IDEMPOTENCY_CONFLICT`,
`MEMORY_HEAD_UNCOMMITTED`, `BLOCKING_QUESTION`, `BLOCKING_CONFLICT`,
`PLAN_COMMIT_CONFLICT` — all mapped to exit 6 (domainState) in the central
total exit-code table.

## Testing

35 files / 328 tests on Node v24.21.0 (formal runtime contract) and Node
v22.23.2 (development regression): migration 4→5 (preserve, legacy HEAD,
rollback, old-writer fencing, structural validator), hash determinism
(including key-insertion-order invariance), normalization authority-
stripping, candidate simulation, DB-level immutability raw-SQL negatives,
E2E chains (§88/§89), exact-commit byte equality (§46), staleness with
frozen precedence (§92), blocking gates (§90), tampered-canonical fail-closed
(§23), and real multi-process prepare/approve/retry races (§64/§65/§95).

## Phase 7 boundary

Everything still deliberately absent: MCP tools (`tools/list` stays `[]`),
`requiresUserInteraction` handler, HostContextEnvelope/HMAC, SessionStart/
PreToolUse/UserPromptSubmit hooks, Plan Mode transition, Section completion
workflow, FinalPlan/final approval/FinalizationGate, handoff,
Observation/Evidence, Context Assembler, Synthesis, Validator. The
`requiresUserInteraction` MCP handler is the sole future production bridge
that may construct `UserApprovalAuthorization` from a real Claude Code
user decision.
