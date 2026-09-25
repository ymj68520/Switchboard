# Phase 2E2 Implementation Report

## Implemented

Section completion, dependency closure, and work progression — closing Detail
into a safe, frozen Synthesis entry state:

```text
active checkpointed Section
      ↓  ultraplan_request_completion(kind="section") — no model inputs
Harness resolves activeWork → root → EXACT current approved revision,
validates deterministic gates, freezes one section_completion Proposal
      ↓  explicit user Approval
atomic PlanCommit:
  Section.status active → approved (pointers/validation unchanged)
  next activeWork = first eligible Section (canonical order,
    dependency-eligible) — same commit
  …or, on the LAST completion: activeWork cleared + detail → synthesis
```

Plus sanctioned manual focus switching (`ultraplan_request_section_focus` →
durable `transitionActiveWork` with expected-focus CAS) and the temporary
Synthesis capability narrowing (the old provisional `request_synthesis`
synthesis→final shortcut is withheld in the now-reachable synthesis stage).
The frozen architecture spec was not modified.

NOT implemented (Phase 2F+, per brief §49): completed-Section reopen/amendment,
Architecture reopen, DAG structural amendment, SynthesisInput/SynthesisManifest,
implementation-order derivation, cross-section semantic synthesis, validator
subagent, Semantic Validation, FinalPlan, Final Approval, handoff, Context
Assembler, token budgeting, ContextTrace, Evidence Audit, generated Markdown plan.

## Section Completion Contract

`Proposal.type = section_completion` (existing type, no new proposal type)
scoped to the exact `SectionRef`, carrying the existing closed
`complete_section` change. Refined contract (brief §5): the change now binds
`target: SectionRevisionRef` = the EXACT current approved checkpoint — no
"complete latest" resolution anywhere — plus an optional Harness-captured
`completion` projection (`sectionTitle`, `validation`, dependency statuses):
identity/presentation metadata for the approval view, hash-bound, never
design content. `complete_section` exists ONLY inside `section_completion`
proposals and a `section_completion` proposal MUST carry one — enforced at
freeze (`proposal_type_invalid`) and independently at the engine
(`section_completion_type_invalid` / `section_completion_missing` /
`section_completion_stage_invalid`).

## Completion Preconditions

At preparation (freeze) and independently again at commit (brief §8): active
lifecycle; stage = detail; activeWork present and == target Section; Section
committed; `status == active`; `currentRevision`/`approvedRevision` present
and equal; exact SectionRevision exists; contract identity stamped with the
target's own section+revision; dependency bindings still match staged state;
`validation == valid`; all structural dependencies approved. The engine
re-checks everything the freeze validated for hostile/direct proposals.

## Dependency Completion Gate

The frozen rule is preserved, reused — not replaced (brief §8/§9):
`assertSectionCanComplete` requires every structural dependency root
`status == approved`. A dependency having an `approvedRevision` (checkpoint)
is explicitly INSUFFICIENT (test 10): checkpoint approval ≠ completion.
The dependency gate takes precedence over the validation gate when both
fail (§7's precise-blocker ordering; §45's "fails because dependencies are
incomplete").

## Validation Gate

`Section.validation == valid` is required (brief §10). A `needs_review`
Section must receive a new checkpoint against the current exact dependency
contracts first (the Phase 2E1 revalidation mechanism). No
`force_complete`/`ignore_validation`/`mark_valid` path exists. The gate
fires at freeze (`section_needs_review`) and at commit
(`transaction_validation_failed` + `section_needs_review`).

## Completion Proposal / Approval

`requestCompletion(kind="section")` was restored from the 2E1 deferral with
the argument surface NARROWED to `{kind}` (brief §32: the model may at most
request kind = section; `sectionID` was removed — the Harness resolves
activeWork). Freeze returns PRECISE blocker errors instead of preparing
doomed proposals (brief §7): `capability_not_available` (stage), 
`invalid_scope` (no focus / non-active root), `revision_missing`,
`revision_mismatch`, `section_needs_review`, `dependency_incomplete`,
`evidence_not_fresh`. The approval view renders the §33 shape — SECTION
COMPLETION, Section identity, `Completing revision: SEC-###@n`, `Status:
active -> approved`, `Validation:`, dependency approval statuses, contract
identity line — WITHOUT re-rendering the design body (completion
re-authorizes no design facts). The hash binds the exact
`SectionRevisionRef` target (test 20).

## Section Root Completion Semantics

One atomic commit: `status: active → approved`; `currentRevision` and
`approvedRevision` UNCHANGED (§15 — the old engine wrote `approvedRevision`
on completion; the 2E1 pointer semantics make that redundant and the
refinement is documented); `validation: valid`; no new SectionRevision; the
revision and contract remain byte-identical (deep-equality test).
`awaiting_approval` root status stays reserved — `beginProposalApproval` /
rejection never touch the root (§16). Rejection and commit failure mutate
nothing; approvals stay retriable and exact retries idempotent (§17/§18).

## ActiveWork Authority Refinement

`activeWork` remains in `COMMIT_GATED_RUN_FIELDS` — generic saveRun mutation
stays forbidden (`commit_gated_run_field` regression kept) and
`set_active_work` remains in `FORBIDDEN_TOOL_NAMES`. The §19 refinement is
documented in protocol §7.9: committed design mutation ≠ Harness-controlled
workflow focus transition. Two sanctioned paths exist: (a) automatic
progression computed INSIDE the completion PlanCommit (engine authority),
(b) the narrow `transitionActiveWork(planID, expected, next)` store operation
behind the focus tool. The test-only seeding seam gained an explicit
`activeWork` option for constructing unreachable states (documented as
TEST-ONLY).

## Manual Focus Switching

`ultraplan_request_section_focus({sectionID})` — authority `working_state`,
capability `request_section_focus`, granted in both detail section-ready
substates. Preconditions (§21): committed Section of the run; status
pending|active (never approved/reopened in 2E2); stage detail; lifecycle
active; target ≠ current focus (idempotent no-op otherwise, no duplicate
event). NOT a Proposal, NO user approval (§20). Durability (§22): the store
operation revalidates the EXPECTED current focus authoritatively INSIDE the
mutation block — for `DurablePlanStore` that is under the O_EXCL write lock
after rehydration — so cross-instance stale transitions fail closed with
`stale_active_work`; there is no last-writer-wins focus drift. Audit (§23):
one `run.active_work_changed {from, to}` event per manual transition;
in-commit progression emits no redundant event.

## Deterministic Next-work Selection

Inside the SAME staged transaction (§24): eligible = Sections in CANONICAL
(Phase 2D committed) order where `status != approved` AND every structural
dependency `status == approved`; next = first eligible — assigned to
`staged.activeWork`. The model is never asked; no ranking heuristics exist.
Rationale (§25): discussion may jump ahead, automatic progression follows
dependency closure. With work remaining and an empty eligible set the commit
fails closed (`no_eligible_section`, §26) — constructed in tests via an
inconsistent seeded state (dangling dependency), since acyclic backward-edge
DAGs cannot reach it through real flows.

## Atomic Work Progression

Section approved + next activeWork + Snapshot + events + PlanCommit + HEAD
publish in ONE transaction (§27); a fault-injected publication failure
leaves the Section active and the focus unchanged (crash never leaves
"Section approved but workflow focus ambiguous").

## Last Section → Synthesis Transition

When the staged completion approves the last remaining Section AND every
Section is `valid`, the SAME commit clears `activeWork` and sets
`stage = synthesis` (§28) — no second post-commit stage write; the
`run.stage_changed` event is part of the same publication. An
all-approved-but-invalid DAG fails closed (`sections_not_valid`). The
snapshot records the closed DAG (`sectionRoots` all approved/valid) with
`activeWork` absent — meaningful absence (§35).

## Synthesis Capability Safety

Synthesis is now REACHABLE, and the surface is minimal-safe (§30/§31):
`read_status`, `read_memory` (lifecycle base) plus harmless blocker-raising
(`record_question`, `propose_question_resolution`, `raise_conflict`). Withheld:
`request_synthesis` (the provisional synthesis→final gate — must never bypass
SynthesisManifest/semantic validation), `request_reopen`, `prepare_proposal`,
`promote_evidence`, checkpoints, focus switching. The `requestSynthesis`
controller method stays registered but the capability gate fails
deterministically everywhere (`capability_not_available`). `checkFinalization`
is NOT called during Detail closure (§29) and remains covered by its own pure
function tests for Phase 2F.

## Evidence / Conflict Checks

§12: the engine's existing critical-evidence gate was extended along the only
chain the domain can represent — target SectionRevision → referenced
committed Decisions → their Evidence refs — both at freeze
(`assertCompletionEvidenceFresh`) and at commit; nothing else is scanned.
Freeze-side blocker code: `evidence_not_fresh`. §13: no global
blocking-question gate (a blocking question does not block completion —
tested). §14: the engine's `conflict_blocking` validation for refs relevant
to the transaction is untouched and regression-tested.

## Snapshot / Durable Semantics

`SnapshotState.activeWork?: WorkRef` — additive, optional (present when the
commit establishes the focus: decomposition's initial focus, ordinary
completion's next Section; absent pre-decomposition and after the final
completion). `STORE_SCHEMA_VERSION` stays 1; the durable document validator
shape-checks the field when present. No revision/contract content is
duplicated into snapshots.

## Restart Recovery

Durable reopen tested at every §40 matrix point: checkpointed active Section
before completion; completion Proposal ready (exact hash); awaiting without
approval; Proposal + durable Approval (retry commits); ordinary completion +
next focus (deep-equal run/sections/commits/events; snapshot `activeWork` =
next Section); manual focus switch (one durable event); last completion +
synthesis entry (deep-equal authoritative state). See §51 PRIMARY below.

## Crash / Concurrency Validation

Real child-process crash probes (new modes `section-completion` and
`section-completion-final`, driving a 3-section chain through REAL
checkpoint/completion commits before the seam):

- **Ordinary completion, pre-persist crash:** Section still active, focus not
  applied, HEAD unchanged, Proposal awaiting_approval, Approval durable; the
  retry publishes completion + next focus together.
- **Ordinary completion, post-persist crash:** Section approved exactly once,
  focus = exact next Section, one commit/snapshot (snapshot `activeWork`
  present), idempotent retry returns the same commit.
- **Final completion, pre-persist crash:** stage stays detail, focus still on
  the last Section; the retry publishes approval + focus-clear + detail →
  synthesis together.
- **Final completion, post-persist crash:** stage = synthesis, activeWork
  absent, all Sections approved+valid, exactly one commit/snapshot.
- **Completion concurrency (§43):** two durable instances freeze competing
  completions; A commits (approved + progression), B fails stale via
  `head_snapshot_mismatch`; no duplicate completion/stage/next-focus; exact
  retry idempotent.
- **Focus concurrency (§42):** both instances observed the same expected
  focus; A's transition wins; B's stale-expected transition fails closed
  (`stale_active_work`) — no last-writer-wins drift.

## Tests Added

`test/section-completion.test.ts` (49 tests) covering brief §50 tests 1-46
and 59-62 in-memory plus the durable describes (§40 restart matrix, §51
PRIMARY, §42/§43 concurrency); `test/durable-crash.test.ts` +5 (ordinary
pre/post, final pre/post, clean controls). Updated where the frozen 2E2
semantics supersede older pins — no invariant weakened:

- `capabilities.test.ts` — matrix restructured for the four documented states
  (decomposition-needed / revisionless / checkpointed / synthesis);
  `request_section_focus` added; completion restored in the checkpointed
  substate; synthesis minimized; the declared-but-withheld set
  (`request_reopen`, `request_synthesis`) pinned explicitly;
- `transaction-engine.test.ts` — completion seeds updated to the realistic
  checkpointed root shape (active + `approvedRevision`); the rollback test
  now drives a properly-typed `section_completion` so the invalid change
  still fails in the ENGINE; `assertSectionCanComplete` coverage preserved;
- `protocol-boundary.test.ts` — synthesis probes assert the §30 withholding;
  a scope probe now exercises unknown-section scope directly;
- `architecture-workflow.test.ts` test 29 — rewritten for the RESTORED
  completion: section-scoped completion still cannot complete the
  Architecture or move the stage, and now proves the progression;
- `section-decomposition.test.ts` / `section-checkpoint.test.ts` /
  `authority-boundary.test.ts` — completion calls updated to the
  `kind`-only input; revisionless-withheld assertions retained.

## Live OpenCode Validation

`npm run smoke:opencode` extended honestly (§52): the headless runtime still
cannot reach an approved Section workflow because `ToolContext.ask` is
interactive — the full completion/progression flow remains integration-tested
with the controlled real tool execution surface + ask stub (stated split).
The smoke proves live, against a real `opencode serve` + real session:

1. `ultraplan_request_section_focus` is registered;
2. `ultraplan_request_section_focus` refuses outside detail (structured
   `capability_not_available`);
3. `ultraplan_request_completion(kind="section")` refuses outside
   detail/section-ready (structured `capability_not_available`).

Result: 23/23 checks passed.

## Verification Results

Scoped (`-w @switchboard/opencode`), true exit codes: `typecheck` 0 · `lint`
0 · `test` **333/333 passed** (16 files: 49 new completion tests + 5 new
crash tests) · `build` 0 · `smoke:opencode` **23/23**.

Root aggregate (true exit codes, unpiped):

- `npm run typecheck` — **pass** (0);
- `npm run lint` — **pass** (0) — the two claude-code unused-variable lint
  errors noted in the Phase 2E1 report were repaired by that concurrent
  workstream between the phases;
- `npm run build` — **pass** (0);
- root `npm test` — **fail (exit 1), claude-code only**: all **328/328**
  claude-code tests PASS, but the vitest runner itself dies with ONE
  runner-level error — `Serialized Error: { errno: -4047, code: 'EPIPE',
  syscall: 'write' }` (broken pipe writing runner output; its
  multiprocess/worker test infrastructure) — which fails the workspace
  script. `@switchboard/opencode` **333/333 green in 16 files**.

The root aggregate is therefore NOT green due to `adapters/claude-code`
exclusively (a runner-infrastructure EPIPE, not a test failure); no Phase
2E2 file touches that workspace and it was left untouched per the standing
rule.

## Deviations From Frozen Architecture

None. The frozen spec was not modified. Documented refinements (all inside
the implementation-layer contract the spec leaves open, §38):

- completion no longer writes `approvedRevision` (Phase 2E1 pointer
  semantics made it redundant; §15 requires the pointers unchanged);
- `RequestCompletionInput` lost the `sectionID` argument (brief §32 — the
  model may at most request kind = section);
- declared-but-withheld capabilities (`request_reopen`,
  `request_synthesis`) remain in the frozen vocabulary with deterministic
  capability errors everywhere, until their real workflows exist.

Amendment candidates for the architecture: none identified — the frozen
`complete_section` change shape, the state machine's detail → synthesis
edge, and the §6 root status vocabulary accommodated the workflow without
contradiction.

## Risks / Open Issues

- **The `no_eligible_section` fail-closed path is unreachable through real
  flows** (acyclic backward-edge DAGs always leave an eligible first
  unapproved Section). It remains as defense-in-depth for inconsistent state
  (e.g. future DAG amendments). Test 35 constructs it via seeded state.
- **An all-approved-but-invalid DAG deadlock:** completion requires valid,
  so the state is unreachable through real flows; if constructed, the
  sections_not_valid gate blocks synthesis entry and 2E2 focus switching
  cannot target approved Sections to re-checkpoint them. Phase 2F/2G reopen
  work should provide the sanctioned exit (recorded as the §47 deferral).
- **Evidence reachability is intentionally narrow** (SectionRevision →
  committed Decisions → Evidence). Deeper audit belongs to the Evidence
  Audit phase (§49).

## Phase 2F Entry Conditions

```text
PlanningRun.lifecycle = active
PlanningRun.stage = synthesis          (entered atomically by the last completion)
activeWork = undefined
all Section roots: status = approved, validation = valid
approved Architecture (ARCH@n) committed
exact SectionRevisions + canonical SectionContracts durable
Decisions / Constraints / Questions / Conflicts / Evidence state durable
request_synthesis withheld (Phase 2F implements the real Synthesis workflow)
```

Phase 2F implements: Frozen SynthesisInput from the exact HEAD Snapshot
(approved architecture, approved Section revisions/contracts, decisions,
constraints, questions, conflicts, evidence state) → planning model derives
the SynthesisManifest (provenance-bound derived statements, implementation
order, cross-section links, limitations/findings) — no new normative design
facts.
