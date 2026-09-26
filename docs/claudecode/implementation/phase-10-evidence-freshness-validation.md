# Phase 10 Implementation Note — Evidence Freshness, Invalidation & Revalidation Gates

Status: implemented and validated (Node 24/22, OpenCode, real Claude Code
2.1.282 live E2E). Builds on the frozen Phase 9 baseline (`4493eed` + `a86aa3f`).
Directive sections are cited as §N throughout.

## 1. What Phase 10 adds (and what it refuses to add)

Phase 9 proved "this Evidence had real provenance". Phase 10 makes the
question answerable per **exact revision**: "the last deterministic/semantic
validation still supports THIS claim". The chain:

```text
Evidence revision → freshness state → source/upstream change detection
→ needs_validation → explicit revalidation → fresh replacement / invalidation
```

…wired into the frozen Proposal path as: Frozen Proposal (canonical V2 with an
exact `requiredEvidence` set) → prepare-time critical gate → post-authorization
freshness gate → PlanCommit.

Refused, per directive: generic `set_evidence_state` primitives, `force` /
`assume_fresh` / `allow_stale` flags (§71), automatic command replay (§14/§44),
automatic design reopen (§49), any Architecture/Section/Synthesis/Finalization
workflow (§55), and any change to the Phase 8 `context_epoch` (§48).

## 2. Schema v7 (`007-evidence-freshness-foundation`, §4)

Three structures, nothing more:

- **`evidence_validation_events`** — append-only freshness history (§5). PK
  `(run_id, event_seq)` per-run monotonic; `UNIQUE(run_id, event_id)`; composite
  FK to the exact `evidence_revisions(run_id, evidence_id, revision)`; nullable
  `request_id` (system facts) and `from_state` (null only for INITIALIZED).
- **`evidence_current_states`** — materialized per-exact-revision state (§7):
  `state`, `last_event_seq` (FK into the events), `updated_at`. It is a
  PROJECTION: rows are updated on every event (only deletion is trigger-fenced),
  and the authority remains the immutable revision + the event log.
- **`proposal_evidence_refs`** — immutable relational index of
  ProposalCanonicalV2's `requiredEvidence` (§34), FK'd to both the exact
  proposal revision and the exact evidence revision, `UNIQUE` de-duplicated.
  Written in the same transaction as the revision; validated equal to the
  canonical content (one authority).
- Plus `idx_evidence_derived_refs_upstream` for deterministic propagation
  lookups, and immutability triggers.

**Terminal-state fence (§8/E8)**: `evidence_validation_events_no_revival`
(BEFORE INSERT) rejects any event whose target revision's materialized state is
`stale`/`invalidated` — an exact revision can never be revived by ANY writer,
including future migrations.

**audit_events is NOT extended (§74)**: freshness transitions have their own
event authority; a second stream would be double authority. `EVIDENCE_PROMOTED`
stays exactly as Phase 9 recorded it.

## 3. Freshness semantics (§1/§2/§8/§57)

- Vocabulary is exactly `fresh / needs_validation / stale / invalidated`
  (DB CHECK + TS type). Freshness belongs to `EV-X@N`, never the identity —
  `EV-X@1 stale / EV-X@2 invalidated / EV-X@3 fresh` is legal (§2).
- `fresh` means *last-known validated state*, never "the source can no longer
  change" (§1).
- Transition matrix (writer-side `isTransitionAllowed` + the DB revival
  trigger): `fresh ⇄ needs_validation`, `fresh/needs_validation → stale`,
  `fresh/needs_validation → invalidated`, plus no-change affirmations
  (fresh→fresh on a passing re-check). `stale`/`invalidated` are terminal.
- Event vocabulary (§6): `INITIALIZED, FILE_CHANGED_HINT, SOURCE_CHANGED,
  FINGERPRINT_VALIDATED, REVALIDATION_UNCERTAIN, REPLACED, INVALIDATED,
  UPSTREAM_CHANGED`. `SET_STATE`/`FORCE_FRESH` do not exist.

## 4. Migration initialization (§9, E3) — the correctness keystone

Every evidence revision that predates the freshness engine is initialized to
**`needs_validation`** with an `INITIALIZED` event
(`reason_code = schema7_failclosed_initialization`, `from_state = NULL`), in the
same migration transaction. `created_at`, observation presence, and recorded
fingerprints are never consulted to guess `fresh`. V1 proposals are untouched
and gain zero inferred evidence refs (§32/E26).

## 5. Promotion initializes freshness (§10)

`promote_evidence` now computes the initial state inside the promotion
transaction (`initializePromotionFreshnessInTx`) and returns it:

- **fingerprint strategy**: the CURRENT whole-file hash of every recorded
  fingerprint is compared against the observation-time fingerprint (§11 —
  Phase 10 never regenerates an "original fingerprint"). All match → `fresh`;
  any mismatch → `needs_validation` (`promotion_fingerprint_mismatch`);
  unreadable → `needs_validation` (`promotion_source_unreadable`).
- **reobserve direct**: `fresh` as last-known observation state.
- **derived**: `fresh` only when EVERY exact upstream revision is currently
  fresh; otherwise `needs_validation` (`promotion_upstream_not_fresh`).

An idempotent promotion replay answers with the recorded INITIALIZED event, not
live state. Whole-file fingerprinting stays exactly Phase 9's: SHA-256 + size +
workspace-relative path; mtime advisory; no AST/symbol/semantic hashing (§12).

## 6. Path resolution (§13)

`resolveEvidenceSourcePath`: workspace-relative path → bound workspace root →
lexical containment check (rejects `..`) → `realpath` of the target or its
deepest existing ancestor → containment re-check (rejects symlink escapes).
Absolute caller paths are rejected outright; cross-workspace fails closed.
Unreadable results are change signals, never matches.

## 7. Revalidation (§20–§29) — `revalidate_evidence`

The 8th MCP tool. Not a generic state setter: the model expresses an action,
Core derives every transition. No `requiresUserInteraction` (§28) but the full
authority chain applies: signed HostContext, exact writable binding generation,
active run, stage capability (discovery/architecture/detail; §29), and the
hook-layer STALE_SESSION_BINDING deny (same as promote/approve).

- **`mode=check`** (§21): deterministic, fingerprint-strategy only. Server
  reloads → resolves paths → re-hashes → compares. Unchanged →
  `FINGERPRINT_VALIDATED → fresh`; changed/unreadable → `SOURCE_CHANGED →
  needs_validation` **plus derived propagation** (§16). On a reobserve-strategy
  revision it is `EVIDENCE_REVALIDATION_INVALID`.
- **`mode=assess`** (§22–§25): requires NEW provenance (`observation_refs` or
  `derived_from` — existence, promotability, same-run, and blob integrity all
  validated; no `state` field exists in the schema).
  - `confirmed`: a NEW revision `EV-X@(N+1)` with the same claim semantics and
    the new provenance is created through the promotion insertion path; its
    §10 initial state is computed FIRST, and if it would not be `fresh` the
    whole revalidation fails with `EVIDENCE_PROVENANCE_STALE` — no revision is
    ever created `needs_validation` as a "confirmed" result. Success: new
    revision INITIALIZED fresh, old revision REPLACED → stale, derived
    dependents of the OLD exact revision propagate to needs_validation, and
    one `EVIDENCE_PROMOTED` audit row records the write.
  - `contradicted`: real new provenance required; `INVALIDATED → invalidated`
    (the contradiction provenance is stored in the event detail); NO reverse
    claim is created; propagation runs. The revision is terminal afterwards.
  - `uncertain`: `REVALIDATION_UNCERTAIN → needs_validation`; no revision; no
    propagation.
- **§26**: only the lineage-current revision can be revalidated;
  `EVIDENCE_REVISION_NOT_CURRENT` otherwise (checked before the terminal check —
  a stale historical revision answers NOT_CURRENT). Historical revisions stay
  readable. The current revision being invalidated is terminal:
  `EVIDENCE_STATE_INVALID`; the lineage moves forward only via
  `promote_evidence`.
- **§27 idempotency**: `operationId = revalidate:<signed toolUseId>`. A replay
  reconstructs the §51 result envelope from the operation's own validation
  events (primary event + UPSTREAM_CHANGED events + the INITIALIZED
  `supersedes` link); same id + different request hash → `IDEMPOTENCY_CONFLICT`.
  No state is rewritten to answer a retry.
- **§51 result**: `status / target{evidence_id, revision, previous_state,
  current_state} / replacement? / affected_derived? / reason` — never raw rows.
- **§52 read models**: `getEvidenceState`, `getEvidenceValidationHistory`,
  `resolveEvidenceProvenanceClosure` (application layer; no new read tool).

## 8. Reobserve semantics & the git coarse check (§14/§15/§45/§46)

Commands are never replayed — there is no code path that executes anything. The
only deterministic drift signal for reobserve evidence is the coarse
repository-revision comparison: recorded `repositoryContext.repositoryRevision`
≠ current `git rev-parse HEAD` (fixed argv, regex-validated, 2s bound) →
`SOURCE_CHANGED` (`git_repository_revision_drift`) → needs_validation at gate
time. HEAD unchanged is never freshness. Non-git workspaces return null and
nothing is inferred — fingerprint evidence still validates by hash directly,
runtime evidence simply keeps last-known state (§46).
The FILE_CHANGED_HINT event type stays defined and transition-tested, but the
host probe (below) found no producer, so nothing emits it.

## 9. FileChanged host probe result (§18/§19/§67)

Probed on real Claude Code **2.1.282** (Windows, headless `-p` run with a
`--plugin-dir` probe plugin): the `FileChanged` event NAME is accepted by the
host's hooks.json validator (while `FileChange`/`WatchFiles` are rejected as
"unknown hook event"), but **no `FileChanged` event fires on real file edits**
(two Write-tool modifications produced zero events while the PostToolUse
controls fired each time; matcher and matcher-less registrations were both
silent). Per §18: no substitute hook was invented, no Edit/Write-based second
source-change oracle was built (§19), and Phase 10 still passes — correctness
is guaranteed by gate-time fingerprint validation; FileChanged would only have
been a latency hint. The validation record states: *FileChanged unavailable on
the tested host; correctness covered by gate-time fingerprint validation.*

## 10. ProposalCanonicalV2 & requiredEvidence (§30–§34)

- `buildProposalCanonicalV1` is frozen verbatim; a golden-hash test pins the
  V1 serialization (§62: `sha256:1a9d50ac…7182` for the fixed Phase 6 test
  vector) — historical proposals are never rewritten or re-hashed and never
  gain inferred refs.
- `buildProposalCanonical` now emits **V2 for every newly frozen revision**
  (§33), even with an empty set. V2 adds `requiredEvidence: EvidenceRef[]`
  — exact `{evidenceId, revision}` pairs, deterministically sorted, hashed
  into `canonicalJson`/`proposal_hash` (§62 hash tests: same set in any
  insertion order → same hash; different revision/id → different hash).
- `proposal_evidence_refs` is written at freeze time and is the ONLY relational
  index; gates read it, so canonical JSON and table can never disagree.

## 11. The gates (§30/§35/§36/§39–§42)

One evaluator, two instants (`runProposalEvidenceGateInTx` /
`evaluateCriticalEvidenceGateInTx`):

- **Reachability (§30)**: only the proposal's own `requiredEvidence` refs are
  consulted — never "all critical evidence in the run".
- **Prepare-time (§35, `recheck=false`)**: refs must exist, same-run
  (`EVIDENCE_STATE_INVALID` otherwise), and every CRITICAL ref must currently
  be `fresh` (`EVIDENCE_NEEDS_VALIDATION`) — a user is never shown a formal
  approval that already rests on stale critical evidence. Supporting/
  informational never block (§41/E34).
- **Post-authorization (§36/§39, `recheck=true`)**: runs inside the commit
  transaction AFTER the frozen Phase 6 precedence chain (binding → run revision
  → proposal identity/state/hash → HEAD/base → dependencies), so stale
  ownership still answers `STALE_SESSION_BINDING`, never an Evidence error —
  and BEFORE PlanCommit. Critical refs get deterministic re-checks: fingerprint
  → re-hash (§37's commit-time discovery); reobserve → git coarse check (§45);
  derived → **recursive provenance closure** (§40) with the same per-node
  checks. Any `state != fresh` after re-checks → `EVIDENCE_NEEDS_VALIDATION`
  with machine-readable details `{evidence_id, revision, state, reason,
  validation_strategy}`.
- **Architecture completion (§42)**: it is a proposal type, so both gates
  apply to its `requiredEvidence` automatically; no Section rules (Section
  completion stays `PROPOSAL_TYPE_UNAVAILABLE`).

## 12. Atomicity & system facts (§37/§38/§65/§66)

Approval + PlanCommit remain one all-or-nothing transaction; Evidence events
are NOT part of it. When the commit gate fails, the main transaction rolls back
(no Approval, no PlanCommit, HEAD untouched, proposal still awaiting) and the
engine re-runs the gate evaluation in a FOLLOW-UP transaction so the discovered
system facts (SOURCE_CHANGED + propagation) persist durably (§37/E31) — this is
not a partial PlanCommit. A failed attempt writes no authorization idempotency
success (§66); a successful authorization replays idempotently (Phase 6 §61/62
unchanged).

## 13. No mutation proofs (§48/§49/§73)

Evidence state changes never move HEAD, never bump `planning_runs.revision`,
and never modify Architecture/Section/Decision memory (asserted by the Phase 9
no-mutation suite, which still passes on the v7 store). `context_epoch` remains
head-derived; the Recovery Capsule is byte-identical to Phase 8's (§48).

## 14. MCP surface (§50, E46)

Exactly eight tools: `start_or_resume, get_state, get_context, read_memory,
list_observations, promote_evidence, revalidate_evidence, approve_proposal`.
`promote_evidence` now also returns `freshness {state, reason}` from §10. No
`prepare_proposal / takeover_run / abort_run / submit_synthesis /
request_finalization` exist, and no `set_evidence_state`.

## 15. Error vocabulary (§53)

Added: `EVIDENCE_NEEDS_VALIDATION` (uniform Proposal-gate code — even when the
exact state is stale/invalidated, with the real state in details),
`EVIDENCE_STATE_INVALID`, `EVIDENCE_REVISION_NOT_CURRENT`,
`EVIDENCE_REVALIDATION_INVALID`, `EVIDENCE_PROVENANCE_STALE` — all domainState
exit codes. Phase 9's codes are unchanged.

## 16. Import boundaries & tests

Freshness event writes are reachable only through
`application/evidence-freshness-service.ts`, the promotion init in
`evidence-service.ts`, and the gate in `application/evidence-gate.ts`. New
suites: `evidence-freshness.test.ts` (§9/§10/§57–§61/§71),
`proposal-evidence-gate.test.ts` (§35–§43/§62–§66/§70),
`mcp-phase10.test.ts` (§20–§29/§50/§51/§53), `store-migration-v7.test.ts`
(§9/§54–§56). Phase 9's "no freshness machinery" test now asserts the Phase 10
boundary (the two real tables exist; the banned substitutes never appear).

## 17. Live validation

See `docs/claudecode/validation/phase-10-live-evidence-freshness-validation.md`
(real-host changed-source gate block, revalidation closure, revised-proposal
commit; FileChanged probe record).

## 18. Phase 11 boundary

Nothing here implements Synthesis, Section workflow, Finalization audits of
supporting/informational evidence, Evidence-in-Capsule epoch evolution, or any
takeover/abort surface. Those belong to later phases.
