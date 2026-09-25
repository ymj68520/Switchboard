# Phase 2D Implementation Report

## Implemented

The project-specific Section DAG: from `stage=detail / ARCH@n / sections=[]`,
the planning model proposes the decomposition; the Harness assigns
authoritative identity, resolves draft-local references, validates the whole
graph, freezes one exact proposal (including the initial focus), and — after
one explicit user approval — publishes Section roots + `PlanningRun.sections` +
`PlanningRun.activeWork` + Snapshot + HEAD in ONE atomic PlanCommit. The stage
stays `detail` (§21); the state difference is structured
(`sections=[] → [SEC-…]`, `activeWork: none → SEC-…`). No SectionRevision or
SectionContract is fabricated; detailed Section design is Phase 2E.

New code: `add_section` / `select_initial_section` change kinds (engine +
dedicated freeze path), `ultraplan_prepare_section_decomposition` tool +
`prepare_decomposition` capability, state-dependent detail substates in the
capability matrix, `SnapshotState.sectionRoots`, `section.added` event,
commit-gated `activeWork`, decomposition-aware status/L0 rendering, and the
Phase 2D crash-probe mode. Protocol document bumped to **v0.4**.

## Decomposition Contract

Tool decision (§25/§26): a DEDICATED tool, `ultraplan_prepare_section_decomposition`,
with input `{ sections: [{key, title, objective, dependsOn[]}], initialSection }`.
`add_section` / `select_initial_section` are deliberately NOT in the generic
`prepare_proposal` vocabulary (hostile inputs through it fail with
`proposal_kind_unsupported`) — loose incremental section creation is
structurally impossible, and the dedicated schema is the strongest typed
boundary with zero duplication. Representation per §5: `Proposal.type =
design_checkpoint`, `scope = { id: "ARCH", revision: N }` (the exact committed
ArchitectureRef, never "latest") — no new proposal type was invented.

## Draft-local → Authoritative Section Resolution

Draft keys (`"plan-memory"`) exist only in tool input; they are never persisted
as identities. At freeze the Harness: validates shape (≥1 section; unique
non-empty keys/titles/objectives; known dependency keys; no self edges; no
duplicate edges; dependencies reference EARLIER entries — the rule that keeps
the approved order canonical and makes cycles unrepresentable; known
`initialSection`), then assigns `SEC-###` via the durable allocator
(`nextSequence` over the run's committed sections — no process-local counters,
no model-supplied ids), resolves every edge to exact `SectionID`s, and freezes
the resolved form. Ids never change across freeze → approval presentation →
commit; the hash binds them (identical decompositions in fresh worlds hash
identically — tested). Rejected proposals keep their frozen content and are
never renumbered; a new full decomposition may re-issue the uncommitted SEC
range (allocator semantics, §37).

## Section Root Semantics

§10/§11/§46 conclusion: decomposition creates Section ROOTS with
Harness-assigned workflow values — `status: "pending"`, `validation: "valid"`,
`currentRevision`/`approvedRevision` absent — and nothing else. The model
cannot create `approved`/`reopened`/revision-bearing sections (engine rejects
non-pending roots with `change_invalid`). **Section `status="active"` was
audited and deliberately NOT used** (§11): the frozen model already separates
work focus (`PlanningRun.activeWork`) from artifact status, and no
transaction-safe meaning of a committed `active` root exists yet — the root
remains `pending` while `activeWork` carries the focus. The status machine
itself is untouched (Phase 2E concern).

## DAG Validation

Two independent gates (§17/§18). Freeze: the full draft validation above plus
the existing `assertAcyclicSections` invariant layer (no second cycle detector
was written). Commit: the engine re-validates stage `detail`, exact
architecture scope, initial-only, fresh ids, edges resolvable in STAGED state,
no self edges, acyclicity over staged sections, and the initial focus existing
in staged state — deterministic failure codes `decomposition_stage_invalid`,
`architecture_scope_mismatch`, `decomposition_already_committed`, `change_invalid`,
`unknown_reference`, `section_dependency_cycle` inside
`transaction_validation_failed`. Hostile direct engine calls are tested.

## Proposal / Approval Semantics

One proposal, one approval, one commit (§6/§20). The approval view
(`renderProposalForApproval`) renders the exact resolved DAG — proposal
identity, `Architecture scope: ARCH@1`, per-section `ADD SECTION SEC-### —
title / objective / depends on:` lines (canonical order), the
`SELECT INITIAL SECTION SEC-###` line, and the approval hash — as a pure
function of the frozen payload (§16/§36). Rejection (§37): proposal →
rejected, zero sections, `activeWork` unchanged, HEAD unchanged, and the model
may propose a new full decomposition. Commit failure (§38): fault injection
leaves zero DAG mutation with the approval durable and retriable; a stale HEAD
requires a new proposal + approval per existing semantics (§42 test).

## Initial Focus Semantics

`select_initial_section { section: SectionRef }` — the narrow internal change
of §13. Valid only at the initial decomposition boundary (engine: refused when
the run had any pre-existing sections); the target must exist in staged state;
the exact resolved ref is part of the hashed proposal, so the focus cannot
change after approval. No generic `set_active_work` exists; `activeWork` is
now in `COMMIT_GATED_RUN_FIELDS`, so forcing it through the run-header path
fails with `commit_gated_run_field`. Per §12 the initial section may have
dependencies (discussion ≠ completion); `assertSectionCanComplete` is
unchanged and regression-proven post-DAG (§32).

## Atomic Detail Admission

The decomposition commit publishes all Section roots, `PlanningRun.sections`
(canonical order), `PlanningRun.activeWork`, the DAG Snapshot, the PlanCommit,
`section.added` audit events, and HEAD in the same synchronous publication —
the engine's staged `activeWork` flows through `stagedRun` exactly like the
other commit-gated fields, so "DAG committed but no focus" is unreachable
(§20; crash-tested on both sides of the durable rename). No
`needs_review` propagation is triggered by creation (§33, tested).

## Snapshot Representation

§27 audit finding: the previous snapshot recorded only Section *revisions* —
insufficient for revision-less DAG state. `SnapshotState.sectionRoots`
(minimal root projection: id, title, objective, dependencies, status,
validation, in canonical order) now represents the committed graph with zero
fabricated revisions; `sectionRevisions` stays `{}` until real designs exist.
**Backward compatibility / schema decision (§28/§29): `STORE_SCHEMA_VERSION`
remains 1 — the field is additive and optional; snapshots created before 2D
legitimately predate decomposition and their absent `sectionRoots` is
meaningful (never backfilled, never defaulted away). Durable document
validation gained a fail-closed shape check for the field when present.** The
read path still reconstructs the DAG from Plan Memory (`listSections`,
snapshot roots), not conversation.

## Capability Matrix Changes

`getCapabilities(run)` now resolves detail from structured state (§22/§24),
remaining the single source of truth:

- **detail/decomposition-needed** (`sections=[]`): reads, questions,
  conflicts, evidence, proposal preparation, user-approval requests +
  `prepare_decomposition`; Section completion/reopen WITHHELD (§23 — no tool
  can pretend a Section exists).
- **detail/section-ready** (DAG committed): the Section surface
  (`request_completion`, `request_reopen`); `prepare_decomposition` withheld
  (initial-only).

Registry `allowedStages` derivation runs both detail synthetic variants and
grants the stage where a capability is available in EITHER (stage-level
projection documented in the protocol); the authoritative per-run gate stays
`getCapabilities` on the real run — no `hasSections` logic duplicated in tools.

## Plan Memory Section Reads

§30: `plan_memory(kind=section, id)` reads the Section root (identity, title,
objective, dependencies, status) with no revision required;
`dependenciesOf=<SEC>` now returns structural dependency ROOTS even when
dependency contracts cannot exist yet (the old code silently skipped
dependencies without approved revisions — fixed). SectionContracts are not
created (§31).

## Restart Recovery

§40 matrix covered against `DurablePlanStore`: detail/no-decomposition; ready
proposal (exact hash survives); awaiting proposal without approval (honest —
commit refused `approval_not_found`); awaiting + durable approval (exact retry
commits); committed (§49 PRIMARY: close/reopen deep-equality of run, sections,
snapshot, proposal, approval, events — same order, same DAG, same `activeWork`,
same HEAD, idempotent retry). Process-level crashes (§41) run in real child
processes (`crash-probe.mjs section-decomposition`, which reaches detail
through a real completion commit before arming the seam): pre-persist crash →
zero DAG mutation + durable approval retried to success; post-persist crash →
exactly one complete DAG transaction, correct `activeWork`, idempotent retry.
Concurrency (§42): two independent durable instances freeze different
decompositions at the same HEAD; A commits; B's commit fails
`head_snapshot_mismatch` — no merge, no fork.

## Crash / Concurrency Validation

See above; all inside `npm test` (durable-crash + section-decomposition
suites). **Narrow stale-read fix surfaced by §42:** writer B's *prepare* read a
per-instance cached document and could allocate a proposal id writer A had
already frozen. Per the carried 2B2/2C limitation note ("fix the narrow
problem if normal operation reveals one"), out-of-lock durable reads now
refresh from disk (one small atomic file; suppressed inside the writer lock so
the 2B2 mid-mutation hazard cannot recur), while commit-time revalidation
remains the authority.

## Tests Added

`test/section-decomposition.test.ts` (37) + 3 decomposition crash probes +
2 parity cases (both stores) → **14 files / 237 tests, all green** (was 195).
§47 mapping: 1–34, 36–51 direct (35 = partial-staging rollback via hostile
direct proposal; 44/45 = process crash probes; 52–54 = the whole pre-existing
suite plus the untouched durable/parity/crash suites remain green). Existing
contract fixtures updated where 2D deliberately narrowed semantics: capability
matrix literal (detail split into both substates), exact status blocks (new
`Active work:` line), 2C renderer assertion (`Sections: not decomposed` in the
empty-detail state), and the authority-audit expectations
(`capability_not_available` for section completion/reopen before sections
exist — the §23 withholding itself).

## Live OpenCode Validation

`scripts/opencode-live-smoke.mjs` extended to 18 checks: the new
`ultraplan_prepare_section_decomposition` tool is registered on a real server,
and a real model invocation outside `detail/decomposition-needed` is refused
live with the structured `capability_not_available` (deterministic boundary
proof). The full live `detail → ready decomposition Proposal` leg was NOT
scripted: reaching detail live requires a real Architecture-completion
approval, which headless smoke cannot answer (no faked `ToolContext.ask`).
That leg is integration-proven end-to-end with the controlled ask stub — the
§49 primary test — including the durable reopen. The live/integration split is
stated exactly, per §48.

## Verification Results

- OpenCode scope (all run for this report):
  `npm run typecheck -w @switchboard/opencode` — 0 errors;
  `npm run lint -w @switchboard/opencode` — 0 problems;
  `npm test -w @switchboard/opencode` — 14 files / **237/237 tests pass**
  (includes the process-crash suite; `pretest` rebuilds dist);
  `npm run build -w @switchboard/opencode` — emitted;
  `npm run smoke:opencode` — **18/18 checks pass**, including the two new
  Phase 2D live checks (decomposition tool registered; live model invocation
  refused with structured `capability_not_available` outside
  detail/decomposition-needed).
- Root aggregate: `npm run typecheck` ✓ · `npm run lint` ✓ · `npm run build` ✓ ·
  root `npm test` **NOT green**: `@switchboard/opencode` contributes 237/237
  passing; `adapters/claude-code` currently fails **30 tests in 8 files**
  (its SQLite store lifecycle / migration-v2/v3 "planning-run-foundation" /
  multi-process suites — that workspace is actively mid-Phase-4 in a parallel
  session). Left untouched per the standing instruction and reported
  separately, per brief §52.

## Deviations From Frozen Architecture

None new. Reused interpretations documented in the protocol: the initial
decomposition rides the existing `design_checkpoint` type scoped to the exact
ArchitectureRef (§5 — no new approval level); detail substates are structured
state, not a new persisted stage (§22); Section roots stay `pending` with the
focus in `activeWork` (§11 conclusion, documented). Snapshot `sectionRoots` is
an additive representation consistent with §10's "snapshot of committed state";
no frozen clause contradicts it.

## Risks / Open Issues

- Out-of-lock read refresh trades a small per-read file parse for cross-instance
  allocation correctness — fine at v0.1 document sizes, worth revisiting if
  documents grow (same O(state) family as the whole-document publication).
- The backward-reference rule means the model must order dependencies before
  dependents; the freeze error explains it, but a permissive topological
  re-ordering (keeping canonical order separately) is a possible future
  ergonomic change — deliberately not done now (§9).
- Amendment/reopen of a committed DAG (structure changes after approval) is
  explicitly unimplemented; refused deterministically (`decomposition_already_committed`,
  capability withholding).
- Section `status="active"` semantics remain reserved for Phase 2E.

## Recommended Phase 2E Starting Point

Section Design Loop on the active Section: draft→freeze `amend_section`-style
SectionRevision proposals against `activeWork` (the existing engine case
already handles `amend_section` on revision-less sections? — verify; likely a
new `add_section_revision`-equivalent resolution path), contract projection on
approval, `request_completion(kind:"section")` wiring to the real revision
flow, dependency-gated progression to the next eligible Section, and
`activeWork` movement as a commit-gated transition.
