# Phase 2C Implementation Report

## Implemented

The first real planning workflow on top of the frozen Phase 1/2A/2A.1/2B1/2B2
substrate — nothing in those layers was redesigned:

```text
/ultra-plan (explicit admission, user-authored goal)
    ↓
DISCOVERY  — explore, record questions, promote Evidence
    ↓ ultraplan_request_architecture   (new; Harness-validated)
ARCHITECTURE — top-level design
    ↓ exact Architecture Proposal (add_architecture + related changes
      + complete_architecture), frozen + hashed by the Harness
    ↓ ultraplan_request_user_approval  (existing gateway; deterministic view)
atomic PlanCommit → immutable ARCH@1, committed constraints/decisions
    ↓ SAME transaction: stage architecture → detail
DETAIL
```

New code: `add_architecture`/`add_constraint` change kinds (engine +
freeze-time resolution), `ultraplan_request_architecture` tool/capability,
`request_completion(kind)` extension, `renderProposalForApproval`
(`memory/approval-view.ts`), stage guidance in the L0 protocol, status-renderer
workflow states, commit-gated constraints. Protocol document bumped to v0.3.

## Discovery Workflow

`ultraplan_request_architecture` (capability `request_architecture`,
discovery-only — derived `allowedStages` is exactly `["discovery"]`, pinned by
tests). Deterministic structural prerequisites only, per brief §11:

- active PlanningRun, current stage `discovery` (capability gate);
- structured goal present (`goal_required` otherwise);
- no prior architecture workflow (structurally implied — architecture artifacts
  cannot exist in discovery; asserted in tests).

No heuristics (no file/evidence/turn minimums). The model requests; the
Harness performs `transitionStage(discovery → architecture)` via the frozen
state machine and persists it (`run.stage_changed` event). `set_stage` /
`ultraplan_force_stage` remain forbidden names with no registry entry; the
engine additionally rejects `complete_architecture` outside
`architecture_completion` proposals (`completion_type_invalid`).

## Goal Semantics

- **Origin:** the user's `/ultra-plan <arguments>` — transmitted verbatim by
  the command template to `ultraplan_start` (goal arg). The model has no tool
  that can author or edit the goal.
- **Durability:** stored on `createRun`; a resume with arguments fills an EMPTY
  goal only (never overwrites an existing one) — tested.
- **Who may update:** only an explicit `/ultra-plan` command invocation
  (admission-gated, therefore user authority). No approval proposal required —
  it is the user's own working-state statement, not committed memory.
- **Enforcement:** discovery cannot complete without it (`goal_required`), so
  production runs never carry a meaningless default into architecture.

## Constraint Authority Resolution

Two concepts established (brief §13):

- **Candidate constraint** — exists only as conversation/proposal-draft intent.
  There is deliberately NO working-state constraint tool.
- **Committed Constraint** — enters Plan Memory only through
  `add_constraint` → user approval → PlanCommit. The Harness assigns
  `CON-###` and freezes `status: "active"`; duplicate active statements are
  refused at freeze (`proposal_kind_unsupported`).

`PlanningRun.constraints` is now in `COMMIT_GATED_RUN_FIELDS`
(`core/invariants.ts`): any run-header mutation path that touches it fails with
`commit_gated_run_field`, so "committed constraint changes occur only via
PlanCommit" is mechanically enforced, not just documented. Staged constraints
flow into the Snapshot (`constraintIDs`) and the commit publications
(`artifact.revised kind=constraint` event — the only event-vocabulary change,
per brief §22 "real audit meaning").

Natural-language limitation preserved (§14): stored hard constraint ≠
mechanically proven hard constraint; no LLM call inside `commitTransaction`.

## Architecture Proposal Contract

Closed typed input (tool zod schema + controller-side closed-shape parsing,
brief §15) — no untyped blob, no DSL:

```text
summary (non-empty); components [{name, summary}] (unique names);
boundaries [{name, description}] (unique names);
dataFlows [{from, to, description}]; principles [{statement}];
unresolvedQuestionIDs?: QuestionID[]; basedOn?: DecisionID[]
```

These freeze the smallest meaningful v0.1 shapes of the spec's `Component`,
`Boundary`, `DataFlow`, `Principle` (`core/types.ts` Phase 1 minimal shapes —
unchanged). `unresolvedQuestionIDs` resolve against recorded run questions or
`raise_question` changes EARLIER in the same proposal (the real question
objects are embedded verbatim); `basedOn` resolves against committed decisions
or earlier same-proposal `add_decision` changes. Dangling references fail at
freeze (`unknown_reference`).

## Architecture Revision Semantics

- `add_architecture` creates exactly `ARCH@1` (`ApprovedArchitecture`:
  `status:"approved"` frozen by the Harness — the user approves the exact
  resulting object; the engine writes it verbatim, brief §4).
- Rejected when any committed Architecture exists — at freeze
  (`invalid_scope`) and, for hostile direct input, again in the engine
  (`change_invalid`). No silent replacement; amendment is later-phase work.
  `amend_architecture` was deliberately NOT introduced (§5: no speculative
  types).
- Committed revisions are immutable (`stagePutRevision` monotonicity covers
  the architecture registry; snapshot records `architectureRevision`).

## Architecture Approval Flow

Reuses `ultraplan_request_user_approval` unchanged in authority: Harness
`ready → awaiting_approval`, one-shot `ToolContext.ask`, empty `always`/`patterns`,
binding in permission string + metadata, deny → `rejectProposal`. Added per
§18/§19: `renderProposalForApproval(proposal)` — a pure function of the frozen
payload rendering proposal identity/revision, per-change content (architecture
summary, components, boundaries, data flows, principles, decision refs,
constraints, question resolutions, completion target) and the full approval
hash — passed in `metadata.approvalView`. The authoritative payload stays the
Proposal itself; no model inference happens after freezing.

## Architecture Completion Semantics

`request_completion(kind:"architecture")` (brief §24 — one semantic operation,
no duplicate tools) requires: run active, stage `architecture`, an exact
committed Architecture revision (the frozen change targets `ARCH@n`, never
"whatever is latest"). It does NOT run Final Plan finalization (§25/§26): zero
sections, open blocking questions, and stale evidence do not block completion —
tested, including that `checkFinalization` still independently reports those
failures afterward.

## Atomic Architecture → Detail Transition

Implemented inside the Phase 2B1 engine's single validate → stage → publish
block (`memory/store.ts`):

- `StagedState` gained `constraints` and `stage`;
- an `architecture_completion` proposal stages `stage = "detail"` only when
  stage is `architecture` and the resulting committed Architecture revision
  equals the `complete_architecture` target (`completion_stage_invalid` /
  `completion_target_mismatch` failures otherwise);
- `publishTransaction` writes the staged stage and appends `run.stage_changed`
  in the SAME publication (HEAD still last);
- there is no post-commit `saveRun`; a durable restart recovers the run
  DIRECTLY in `detail`.

Proven at four levels: in-memory fault injection (publication failure leaves
Architecture/stage/HEAD unchanged, approval retriable — no re-approval
needed); durable close/reopen; REAL child-process crashes at both seam points
(`crash-probe.mjs architecture-completion` mode): pre-persist crash leaves
stage=architecture + durable approval, retry commits both effects together;
post-persist crash recovers directly in detail with exactly one commit and
idempotent retry.

## Capability / Protocol Changes

- `request_architecture` capability: discovery only.
- `request_completion`: now granted in architecture (architecture-scoped) and
  detail (section-scoped). Everything else unchanged; final/handoff/terminal
  restrictions untouched. All registry `allowedStages`/`allowedLifecycle`
  remain derived from `getCapabilities`.
- Agent-protocol document → **v0.3** (`opencode-ultra-plan-agent-protocol.md`):
  matrix, tool inventory, error codes, discovery/architecture responsibilities,
  architecture input contract, persistence/completion semantics, constraint
  authority, event vocabulary. Frozen architecture file NOT modified. No
  contradictions with the frozen architecture surfaced (none required an
  amendment candidate).

## Repository Evidence Integration

Unchanged trust chain: repository tool → Observation → explicit promotion →
Evidence (§27). The architecture workflow consumes it two ways, both tested:
decision `evidence` refs inside architecture proposals (transaction-time
freshness applies — stale critical evidence fails the whole completion
transaction with `evidence_not_fresh`) and architecture `basedOn` decision
references. No crawler/index built.

## Restart Recovery

All seven §31 checkpoints covered (discovery; architecture pre-proposal; ready
proposal; awaiting proposal; durable approval; post-checkpoint; post-completion):

- discovery→architecture survives close/reopen;
- ready proposal keeps its exact hash (durable validation recomputes it);
- awaiting proposal + no approval → nothing fabricated, commit refused
  (`approval_not_found`), honest path still works;
- durable approval → exact retry commits after restart;
- post-completion reopen: stage=detail, exact `ARCH@1` body, same
  commit/snapshot/HEAD (§34 primary test asserts deep equality across reopen).

## Tests Added

`test/architecture-workflow.test.ts` (39) + 3 crash probes + 3 parity cases
(each ×2 stores) → suite now **195 tests / 13 files, all green** (was 146).
The §35 40-item minimum maps: 1–9 (discovery/architecture/add paths),
10–12 (hash coverage per field), 13–16 (authority/exact refs), 17–24
(atomicity/retry/immutability/snapshot/restart), 25–27 (renderer states
`not started` / `designing` / `ARCH@1 approved` / detail), 28–29 (completion
scoping both directions), 30–32 (checkpoint neutrality, no finalization),
33–34 (evidence survival + staleness), 35–36 (constraint authority),
37–39 (restart hash/approval/retry); 40 = the full pre-existing suite remains
green (2B1 fixtures whose semantics Phase 2C deliberately narrowed were
updated to the new contract: `complete_architecture` is now
`architecture_completion`-only — the boundary is itself tested).

## Live OpenCode Validation

`scripts/opencode-live-smoke.mjs` extended to 16 checks and run against a real
`opencode serve` + real model (`opencode/ling-3.0-flash-fin-free`): new live
proofs are (a) a real model invocation of `ultraplan_request_architecture`
moves the durable run discovery → architecture, and (b) after a REAL server
kill/restart, `/ultra-plan` resumes the SAME run still reporting
`Stage: architecture`. The Architecture Proposal → Approval → PlanCommit leg
uses the real `ToolContext.ask` primitive, which headless smoke cannot answer
automatically — it is covered at integration level with the controlled
`ToolContext.ask` stub (fakeToolContext gateway tests + durable workflow
tests). This live/integration split is stated exactly, per §33; nothing was
faked.

## Verification Results

- OpenCode scope (all run for this report):
  `npm run typecheck -w @switchboard/opencode` — 0 errors;
  `npm run lint -w @switchboard/opencode` — 0 problems;
  `npm test -w @switchboard/opencode` — 13 files / **195/195 tests pass**;
  `npm run build -w @switchboard/opencode` — emitted;
  `npm run smoke:opencode` — **16/16 checks pass** (including the two new
  Phase 2C live checks; the restart-stage check validates the MOST RECENT
  status block in the session history, not a history-wide regex).
- Root aggregate: `npm run typecheck` ✓, `npm run lint` ✓, `npm run build` ✓.
  Root `npm test` is **NOT green**: `@switchboard/opencode` contributes
  195/195 passing, but `adapters/claude-code` currently fails 17 tests in
  6 files (its SQLite store lifecycle / schema-migration / multi-process
  init suites — `store.test.ts`, `store-migration-v2.test.ts`,
  `store-migrations.test.ts`, `store-multiprocess.test.ts`,
  `store-inspect.test.ts`, `store-paths.test.ts`). That workspace is
  concurrent external work under a standing instruction not to edit,
  reformat, or suppress its failures; it was green by its own workstream at
  the end of 2B2 and has since changed state. Reported separately and left
  untouched, per the brief.

## Deviations From Frozen Architecture

None. Stage transitions remain state-machine-gated; the completion-stage
coupling is the §4.1 "architecture completion approval → DETAIL" edge realized
inside the transaction. `complete_architecture` outside
`architecture_completion` is now refused — a narrowing of the Phase 2A
change vocabulary consistent with §11's three approval levels. The renderer's
architecture line format changed (`approved @1` → `ARCH@1 approved`) to match
brief §30 examples.

## Risks / Open Issues

- Whole-document durable publication is O(state size) (carried from 2B2).
- Reads may be per-instance cached between writes (carried from 2B2); no
  stale-read correctness bug surfaced in the workflow, so nothing was changed
  (§32).
- The architecture input contract validates shapes, not design quality — the
  user approval remains the quality gate.
- `add_architecture` is strictly the initial path; reopening/amending a
  committed Architecture is future work and currently deterministic refusal.
- Same-proposal references must appear before their dependents in the
  `changes` array (mirrors engine staging order); this ordering constraint is
  documented in the protocol but not yet surfaced as a distinct error message.

## Recommended Phase 2D Starting Point

Approved Architecture → project-specific Section DAG generation: a
decomposition Proposal vocabulary (`add_section` with frozen `Section` nodes +
dependency edges), DAG validation via `assertAcyclicSections`/
`assertSectionCanComplete`, detail-stage admission so the first Section can go
active, and restart tests for the newly committed Section set. The existing
`detail` capabilities (`prepare_proposal`, `request_completion(kind:"section")`,
`request_reopen`) already provide the section workflow surface.
