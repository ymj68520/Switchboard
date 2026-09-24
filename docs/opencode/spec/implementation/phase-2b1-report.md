# Phase 2B1 Implementation Report

**Scope:** Atomic Proposal → Approval → PlanCommit transaction engine (in-memory; durable persistence is Phase 2B2).
**Frozen architecture:** unmodified. **Protocol:** bumped to **v0.2** (new model-visible approval-request capability).

---

## Implemented

- **Transaction engine** (`memory/store.ts`, `commitTransaction`): full validation → staging on cloned registries → staged-state validation → atomic publication. The engine is the single authority for committed Plan Memory; `parentCommit` is derived from run HEAD (callers cannot supply chain structure), and the input remains `{ planID, proposalID, approvalID }` — no mutation data is accepted outside the approved Proposal.
- **Approval persistence** (`PlanStore.saveApproval/getApproval/findApprovalForProposal/listApprovals`): immutable records bound to `{proposalID, proposalRevision, proposalHash, actor: "user", createdAt}`. Idempotent for exact duplicate deliveries; conflicting bindings and reused ids rejected (`approval_mismatch`).
- **Freeze-time change resolution** (`core/controller.ts` `resolveChange`): stored `Proposal.changes` are now a CLOSED discriminated union of fully-resolved intents (`transaction/types.ts` `ProposalChange`) — `add_decision` / `amend_decision` carry complete `ApprovedDecision` objects, `amend_section` a complete `ApprovedSectionRevision`, `raise_question` a complete `OpenQuestion`, `resolve_question` a `QuestionResolution`, `complete_architecture` / `complete_section` exact `ArchitectureRef` / `SectionRevisionRef` targets. IDs and resulting revision numbers are assigned AT FREEZE (spec §35.10: `DEC-001@2 supersedes DEC-001@1`, never "update latest"). No `content: unknown` remains in stored proposals and nothing is filled in after approval. Untyped content survives only as tool-input drafts, resolved or rejected at freeze.
- **Structured approval gateway** — new model-visible tool `ultraplan_request_user_approval` (capability `request_user_approval`, architecture+detail stages; protocol v0.2). It presents a READY proposal (`ready → awaiting_approval`), blocks on the real `ToolContext.ask` one-shot confirmation (permission string embeds `proposalID@revision:hashPrefix`, full binding in metadata, `always: []`), then: allow → immutable Approval recorded (idempotent) → transaction committed; deny → proposal rejected, no commit. The tool takes only a `proposalID`; the decision binding comes exclusively from the Harness-created `ApprovalRequest`.
- **Controller orchestration** (no duplicated engine rules): `recordApproval` (persist approval; proposal STAYS awaiting), `commitApprovedProposal` (engine invocation), `recordApprovalAndCommit` (gateway path), `rejectProposal` (awaiting → rejected + event, no commit), `beginProposalApproval` (+ `proposal.awaiting_approval` event).
- **Events** (`memory/events.ts`): `proposal.awaiting_approval`, `approval.recorded`, `proposal.rejected`, `artifact.revised`, `question.resolved`, `transaction.committed`, `head.moved`. Failed transactions append NOTHING (state stays byte-identical); operational diagnostics stay outside the event log.

## Approval Persistence Semantics

Immutable; no update method. One proposal has exactly one authorization: exact-duplicate delivery returns the existing record (crash/retry safe), conflicting ones fail with `approval_mismatch`. Approval ids are Harness-assigned from the store sequence at recording time.

## Proposal Status Semantics

```text
ready --beginProposalApproval--> awaiting_approval --commitTransaction succeeds--> approved
                                       |
                                       +--user denies--> rejected (no Approval, no commit)
```

Recording an Approval does NOT flip the proposal to approved. Only a successful commit does, inside the same atomic transaction. A commit failure leaves the proposal `awaiting_approval` and the Approval valid for deterministic retry.

## Transaction Validation Pipeline

Validation completes BEFORE any mutation; failures collect deterministically and throw `transaction_validation_failed` with `detail.failures[]` (machine-readable codes):

run exists → lifecycle active → proposal exists → not already committed (idempotent replay check first: same proposal+approval returns the existing commit; different approval → `already_committed`) → proposal `awaiting_approval` → approval exists (`approval_not_found`) → approval binding exact (id/revision/hash/actor) → proposal hash recomputes → `createdFrom == run.headSnapshot` (`head_snapshot_mismatch`, fail-closed, no silent rebase) → per-change staging validation (targets resolve as exact revisions, resulting revisions monotonic+immutable, fresh ids for new objects, no duplicate questions) → resulting Section DAG acyclic → blocking-conflict intersection (conservative: refs-less blocking conflicts are run-global) → critical evidence referenced by committed decisions is fresh/active → staged completion rules (`assertSectionCanComplete`).

Constraint validation limitation (brief §14), recorded precisely: run `Constraint`s are free-form natural-language statements; nothing in the frozen domain model makes them mechanically checkable, so commit does NOT pretend to verify them. Hard-constraint enforcement remains a documented open item requiring structured constraint representation (architecture amendment candidate).

## ProposalChange Contract

See `transaction/types.ts`. Every supported kind defines: exact target (`supersedes`/`target` refs), expected current revision (amendments: `resulting = supersedes.revision + 1`), the complete resulting content (frozen verbatim into committed state — the engine never regenerates design), and the references needed for validation. Kinds outside the vocabulary are rejected with `proposal_kind_unsupported`; none fall back to generic mutation.

## Atomic Commit Algorithm

```text
gather inputs (async)
→ synchronous: idempotency check → full validation
→ stage on CLONED registries (copy-on-write; values are immutable records)
→ apply every approved change to the staged state
→ validate resulting state (DAG, completion rules)
→ publishTransaction (single protected seam):
    artifact revisions → run header → audit events → Snapshot (SNAP-N+1)
    → PlanCommit (COMMIT-N+1, parent = previous HEAD) → proposal → approved
    → HEAD (headCommit/headSnapshot) LAST
```

Failure at any point before publication discards the staged clones: committed artifacts, question states, proposal status, events, commit chain, snapshots, and HEAD are exactly unchanged (proven by fault injection, below). In-memory atomicity holds because the validate→stage→publish block is synchronous; the durable 2B2 store must provide an equivalent atomic publication primitive.

## Artifact Revision Semantics

- `add_decision`: writes the approved `Decision` verbatim (revision 1, id Harness-assigned at freeze, `status: "approved"`, `approvedAt` frozen at proposal time).
- `amend_decision`: validates the exact prior revision exists, writes the new revision verbatim with `supersedes` linked; the old revision is untouched.
- `amend_section`: validates the exact `SectionRevisionRef`, writes the new revision verbatim, advances `currentRevision`, reopens an APPROVED section **inside the same commit** (never before), preserves the old approved revision + `approvedRevision`, and propagates `needs_review` to downstream sections via the already-tested `propagateNeedsReview`.
- `raise_question`: appends the frozen authoritative question (duplicate text rejected at freeze); working-state `proposedResolution` candidates are never authoritative.
- `resolve_question`: the ONLY `open → resolved` path; applies the exact user-approved resolution (+ optional `resolvedBy`), emits `question.resolved`, and the new snapshot's `openQuestionIDs` excludes it.
- `complete_architecture` / `complete_section`: flip authoritative approval state inside the commit only; completion validates dependency approval rules on staged state.

## Snapshot / Commit Chain

Every successful commit materializes exactly one immutable `SNAP-N+1` (post-commit state: architecture revision, section currentRevisions, decision revisions, active constraints, open question ids) and exactly one `COMMIT-N+1` with `parentCommit` = previous HEAD (`null` for the first real commit, compatible with the Phase 2A S0 snapshot whose `commit` is null). HEAD (`headCommit`, `headSnapshot`) is published last and only on success; previous snapshots are never mutated.

## Idempotency / Retry Semantics

- Duplicate approval delivery → same Approval record returned.
- `commitTransaction` with the same proposal + approval after success → the SAME PlanCommit, zero duplicate revisions/snapshots/commits/HEAD movements.
- Same proposal with a conflicting approval → `already_committed`.
- A stale base snapshot fails closed (`head_snapshot_mismatch`); the proposal must be superseded and re-approved — an approved proposal is never rebased silently.

## Structured User Approval Integration

`ultraplan_request_user_approval` drives the real `ToolContext.ask` with `always: []` and the exact binding in `permission` + `metadata` (asserted by tests 37/38). Persistent "always allow" semantics are structurally excluded: the request carries no patterns, and one approval binds one proposal revision/hash. The deny path (ask rejects) marks the proposal rejected — no authorization record, no commit. Live-runtime note below.

## Events

Deterministic success sequence (tail): `artifact.revised*` → [`question.resolved`] → `transaction.committed` (commit, proposal, approval, snapshot ids) → `head.moved` (from → to). Failure/rejection: rejection appends `proposal.rejected`; transaction FAILURES append nothing (no misleading committed-success events; diagnostics stay out of transactional state).

## Tests Added

`test/transaction-engine.test.ts` (22 tests) covering brief §29 items 1-39: immutable exact approvals (1), idempotent duplicates (2), id/revision/hash/actor mismatches (3-6), ready/rejected proposals cannot commit (7/9), awaiting+valid approval commits (8), stale `createdFrom` fails closed (10), failure leaves HEAD/artifacts/snapshot chain/proposal status untouched (11-14, incl. event-log cleanliness), exactly one commit + linear parent + one post-commit snapshot + HEAD movement + proposal approved on success (15-20), exact-retry idempotency (21), historical revision immutability (22), add/amend decision + amend_section reopen/propagation + resolve_question authority (23-27), completion validation and commit-only completion (28-30), blocking-conflict intersection (31), critical evidence gating + supporting-evidence non-blocking semantics (32/33 via decision evidence references), multi-change rollback (34), deterministic event sequence (35), rejection creates no authorization/commit (36), gateway binding metadata + empty `always` (37/38), no model primitive can mint `actor="user"` (39); suite 40 green (all prior tests preserved: 82 → 104 total). §30 fault injection: a `publishTransaction` override that throws after staging proves zero partial mutation AND that the approval remains available for retry; a valid-first/invalid-second multi-change proposal proves staged-rollback.

## Atomicity / Fault-Injection Results

Both mandatory fault-injection tests pass: (a) valid `add_decision` + invalid `complete_section` (incomplete dependencies) → `transaction_validation_failed` with `dependency_incomplete`; decision NOT committed, no commit/snapshot/events/HEAD change, proposal still `awaiting_approval`, Approval still present. (b) injected publication failure after full staging → same zero-mutation outcome with the Approval retriable.

## Live Runtime Validation

All pre-existing 12/12 live checks re-ran green against the rebuilt plugin (plugin load, config registration, tool surface, denied unauthorized start, /ultra-plan create + resume, deterministic status, single session). The structured approval path was NOT driven through the live server: `ToolContext.ask` blocks on a real TUI confirmation, which the headless smoke cannot answer, and fabricating an interactive session is out of scope. Per the brief, the approval gateway is instead proven at integration level (allow + deny paths through the real `tool()` execute with an ask-capturing ToolContext stub) and the live limitation is stated here exactly.

## Verification Results

OpenCode adapter (this phase's scope), exact results:

```text
npm run typecheck -w @switchboard/opencode → 0 errors
npm run lint      -w @switchboard/opencode → 0 problems
npm test          -w @switchboard/opencode → 9 files, 104/104 tests passed
npm run build     -w @switchboard/opencode → dist emitted (live smoke runs against the built output)
npm run smoke:opencode                     → 12/12 live checks passed
```

Note: during final verification a NEW workspace appeared in the monorepo —
`adapters/claude-code` (`@switchboard/claude-code`, a "Phase Plan plugin"
bootstrap; not part of Phase 2B1 and not modified by it). The root aggregate
`npm run lint` / `npm test` currently fail in THAT workspace (its own unused-var
lint errors and test failures, e.g. `src/runtime/dispatch.ts` and
`test/doctor.test.ts`). The root workspaces glob (`adapters/*`) picks it up
automatically; those failures are outside this phase's scope and were neither
caused nor suppressed here.

## Deviations From Frozen Architecture

1. **`ApprovedDecision`/`ApprovedSectionRevision` timestamps participate in the approval hash.** `Decision.approvedAt` / `SectionRevision.createdAt` are frozen at proposal time so committed objects are written verbatim (spec §9.2 "what the user approves is exactly what gets committed"). The 2A.1 hash statement "no timestamps participate" is narrowed to "no proposal-level workflow timestamps participate"; artifact-embedded timestamps are content. Documented in the hash contract.
2. **Raising authoritative questions via `raise_question`** creates a NEW authoritative (committed) question rather than promoting a working-state one; freeze-time duplicate-text checks prevent accidental semantic duplication (brief §12 ambiguity resolved and documented).
3. **Natural-language hard constraints are not machine-validated at commit** (see Pipeline section) — recorded limitation, not silently pretended.
4. **Conflict scope intersection is conservative**: a blocking conflict with no refs is treated as run-global; precise scope intersection awaits richer conflict metadata.
5. `phase_boundary` error code retired (the boundary it named is now implemented).

## Risks / Open Issues

- In-memory store: a server restart still loses all state, INCLUDING pending approvals — 2B2's durable store must persist approvals + the commit chain with the same atomicity seam.
- `publishTransaction` is a single synchronous seam; the durable store must map it to a real transaction (or equivalent single-writer atomic write) rather than a multi-step persistence.
- Commit validation currently covers run-scoped blocking conflicts and change-referenced critical evidence only; run-wide critical-evidence freshness remains the synthesis gate's job (`request_synthesis`), by design.
- The gateway UX is one `ask()` confirmation with title/summary metadata; a richer approval presentation (diff rendering) can reuse the same `ApprovalRequest` binding unchanged.

## Phase 2B2 Entry Conditions

The full chain is real, deterministic, and tested: frozen Proposal → awaiting_approval → one exact user Approval (immutable, idempotent) → commitTransaction → full validation → atomic application → immutable revisions → Snapshot → PlanCommit → HEAD; failure before publication = zero partial mutation; exact retry = zero duplication; committed state is unreachable outside `commitTransaction` (the only remaining writers are the engine and the loud, concrete-class-only `seedCommittedState` test fixture). Phase 2B2 can proceed to durable Plan Memory with atomic persistent transactions and restart recovery, reproducing exactly these semantics.
