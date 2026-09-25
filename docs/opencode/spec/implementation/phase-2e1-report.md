# Phase 2E1 Implementation Report

## Implemented

The first real **Section design checkpoint** vertical slice inside the
existing authority chain (`LLM → Harness tools → transaction engine →
committed Plan Memory`):

```text
active Section root (revisionless or checkpointed)
      ↓  ultraplan_prepare_section_checkpoint (targets run.activeWork ONLY)
Harness validates the closed typed draft, resolves dependency contract
bindings at freeze, assigns the exact resulting revision identity, and
freezes one design_checkpoint Proposal (full design + compact projection +
SectionContract)
      ↓  explicit user Approval (hash-bound, deterministic approval view)
atomic PlanCommit
      ↓
immutable SectionRevision@n (contract embedded canonically)
root: status=active, currentRevision=approvedRevision=n, validation recomputed
downstream needs_review propagated; stage stays detail; activeWork unchanged
```

New model-facing capability/tool: `prepare_section_checkpoint` /
`ultraplan_prepare_section_checkpoint` (authority `proposal_intent`). New
change kind: `add_section_revision` (first checkpoint only; later checkpoints
use the existing exact-revision `amend_section`). New engine guards:
`checkpoint_stage_invalid`, `checkpoint_scope_invalid`. The checkpoint tool is
the ONLY path that produces `add_section_revision`; it is deliberately absent
from the generic `ultraplan_prepare_proposal` vocabulary.

NOT implemented (Phase 2E2+, per brief §45): Section completion commit,
automatic next-section selection, activeWork progression, manual focus
switching, all-sections-complete detection, detail → synthesis, reopen of
completed Sections, DAG structural amendments, Architecture amendment, Context
Assembler, token budgeting, ContextTrace, Synthesis, Validation, FinalPlan,
handoff, generated Markdown plan.

## Section Root Status Semantics

The Phase 2D reserved `active` status is resolved (brief §4), frozen in the
agent protocol §7.8 and enforced by the engine:

| status | meaning |
|---|---|
| `pending` | no approved SectionRevision exists |
| `active` | ≥1 approved SectionRevision; completion NOT committed |
| `approved` | Section completion Proposal committed (Phase 2E2) |
| `reopened` | previously completed Section reopened (Phase 2E2+) |
| `awaiting_approval` | RESERVED; never persistently toggled |

`beginProposalApproval` does not mutate Section roots — Proposal status
(`ready/awaiting_approval/approved/rejected`) already represents the transient
approval state, and the root changes only inside PlanCommit. A first
checkpoint commit sets `status = "active"`; `amend_section` maintains
`active` (and maps a defensively-`pending` root to `active`; an
`approved` root becomes `reopened` — the existing 2B reopen semantics,
preserved).

## First Revision Semantics

`add_section_revision` (new `ProposalChangeKind`): the frozen committed intent
contains the COMPLETE resulting `ApprovedSectionRevision` with Harness-assigned
`sectionID` (= `activeWork` id), `revision = 1`, `status = "approved"`,
`createdAt`, and a contract projection stamped `sectionID`/`revision` with the
revision's own identity. The engine independently enforces: committed section,
`revision === 1` and no prior revisions (else `change_invalid`), contract
identity, binding sanity (see Dependency Binding), staged-state validation
recomputation. The audit trail is `artifact.revised` (kind
`section_revision`) + `PlanCommit.changes` — no new event type (brief §38).

## Later Revision Semantics

For `currentRevision = N`, `prepareSectionCheckpoint` freezes an exact
`amend_section` with `supersedes = {id, revision: N}` and resulting revision
`N+1` — bound BEFORE the user sees the proposal; no "amend latest" semantics
exist. Previous revisions/contracts remain byte-identical and readable by
exact revision (regression-tested). The commit atomically moves
`currentRevision = approvedRevision = N+1`, keeps the root `active`, and
recomputes `validation` from the dependency contracts bound into the NEW
revision. **Documented semantic refinement:** the 2B-era engine left
`approvedRevision` untouched on amend; under the frozen §17/§18 semantics it
now moves to the new approved checkpoint (2B test 25 updated accordingly —
`assertSectionCanComplete` and the completion path are untouched).

## Section Checkpoint Contract

`SectionCheckpointInput` (protocol §6.3) — a closed typed contract, no
`content: unknown`: `problem`, `design`, `interfaces: InterfaceSpec[]`
(unique names), `invariants: string[]`, `failureModes: FailureMode[]`,
`dependencies: Dependency[]` (the EXACT structural dependency context),
`decisions`/`openQuestions`/`impacts` (ids that must already resolve),
`projection.compact`, `projection.contract {provides, requires, invariants,
interfaces, decisions}`. Validation at freeze: non-empty trimmed strings,
unique interface names, exact structural-dependency coverage (missing / extra
/ duplicate / self edges → `invalid_scope`), reference resolution
(`unknown_reference` for unknown decisions/questions/impact sections),
deterministic contract consistency (below).

## SectionRevision Support Types

Phase 1 minimal shapes reused, refined only where the brief allows
(`Dependency` — the spec does not define it):

- `Dependency` gained `contractRevision?: number` — **Harness-assigned at
  freeze**, never model-supplied, never "latest" (protocol §6.5);
- `InterfaceSpec {name, description, signature?}`, `FailureMode
  {description, mitigation?}`, `InterfaceRef {name, providedBy?}` used as
  frozen in Phase 1 — no interface DSL invented;
- `ApprovedSectionRevision` (2B1) unchanged: `status` frozen `"approved"`,
  contract canonically embedded at `projection.contract`.

## Stable Projection Semantics

Full design + compact projection + contract are ONE approval payload inside
the content-hashed Proposal (brief §9). The commit writes the revision
VERBATIM; compact/contract are never regenerated after approval and never
re-summarized per context build. `renderProposalForApproval` deterministically
renders the complete checkpoint (see Proposal / Approval Semantics).

## SectionContract Semantics

`SectionContract` remains the immutable dependency-facing projection embedded
canonically at `projection.contract` — one canonical immutable value per
revision; no second independently mutable contract source was created
(brief §28). The Harness stamps `contract.sectionID`/`contract.revision` from
the resulting revision; the engine refuses a projection claiming another
identity (`change_invalid`). Deterministic consistency rules (brief §11, no
LLM at freeze or commit):

- contract `invariants` must restate invariants the revision itself states
  (`invalid_scope` otherwise);
- contract `interfaces` must resolve to revision-defined interfaces;
  `providedBy`, if present, must be the checkpoint's own section;
- contract `decisions` must resolve to committed decisions referenced by the
  revision, at their exact committed revisions (`unknown_reference`
  otherwise);
- `provides`/`requires` are explicit approved projection content — NOT
  claimed to be mechanically derived from prose (documented in protocol
  §7.8);
- the strongest additional mechanical rule the support types support: a
  `dependencies[].consumes` name must appear in the bound dependency
  contract's `provides` (`invalid_scope`).

## Dependency Binding

At freeze the Harness resolves, for every structural direct dependency with an
approved checkpoint, the exact `SectionContractRef` —
`Dependency.contractRevision = <approved revision>` — so the user approves
"designed against exactly SEC-X@N" (brief §14). A dependency without an
approved revision carries NO binding (explicit absence; never fabricated). The
draft must record the root's structural dependencies exactly (§12). At commit
the engine re-validates every binding against STAGED state (stale/phantom
bindings → `change_invalid`) while the `validation` verdict itself is
RECOMPUTED from staged state — never taken from approved content. HEAD/base
snapshot protection makes a proposal stale if a dependency commits in between;
no silent substitution ever occurs.

## needs_review Propagation

- **Missing contract (§13):** a checkpoint commits even when a structural
  dependency has no approved contract, but the root commits as
  `needs_review` (`sectionValidationFromDependencyContracts` over staged
  state). Completion gating remains Phase 2E2.
- **First contract appearing / contract change (§15/§34/§36):** committing a
  checkpoint propagates `needs_review` to already-designed downstream
  revisions (transitive, existing `propagateNeedsReview`); downstream
  revisions are never deleted or regenerated.
- **Revalidation (§35):** a new checkpoint binding the current exact
  dependency contracts restores `valid`. There is NO `mark_valid` tool —
  validation follows from approved revisions and their bindings.
- **`impacts` (§23):** must resolve to committed Section roots and never
  mutate them; no automatic `needs_review` from impact metadata.

## Proposal / Approval Semantics

One checkpoint = one `design_checkpoint` Proposal (type unchanged, brief §21)
scoped to the exact `SectionRef`, carrying exactly one section-revision
change; the engine refuses a proposal mixing `add_section_revision` +
`amend_section`. Title/summary are deterministic Harness strings. The hash
covers the full revision body, both projections, the exact resulting revision
number, and the Harness-assigned dependency bindings (14-variant hash-
sensitivity suite + binding/revision-number tests). The approval view
(`renderProposalForApproval`) renders ADD/AMEND SECTION REVISION with
Problem / Design / Interfaces / Invariants / Failure modes / Dependency
bindings (`SEC-001@2 contract` or `SEC-002 unresolved (no contract yet)`) /
Decisions / Open questions / Impacts / Compact projection / Contract
(provides, requires, invariants, interfaces, decisions) / Proposal hash — a
pure projection of hashed content, byte-deterministic, no post-freeze model
summarization. Rejection and commit failure mutate nothing and approvals stay
retriable; exact retries are idempotent.

## Plan Memory Reads

Existing exact-revision reads cover the boundary without inventing fuzzy
resolution (brief §26): `kind=section` (root), `kind=section + revision`
(exact SectionRevision, carrying its canonical contract — "current revision"
= read the root's `currentRevision` pointer, then that exact revision);
explicit historical requests NEVER resolve to latest (`unknown_reference`).
`dependenciesOf=<SEC>` returns dependency roots plus, where approved, their
EXACT approved SectionRevision (with contract); a dependency without a
contract returns its root only — the absence is explicit, never a fabricated
empty contract. Documented in protocol §5.

## Snapshot / Durable Representation

`SectionRootSnapshot` gained additive optional `currentRevision`/`
approvedRevision`; the root DAG (`sectionRoots`) is preserved, so a restart
reconstructs BOTH the DAG structure and the revision state without
conversation history (brief §27). The exact revision content is not
duplicated: `SnapshotState.sectionRevisions` already maps each section to its
current exact SectionRevision reference, and the contract lives canonically
inside the revision. **Schema decision (brief §29):** additive optional
fields with fail-closed shape validation extended — no incompatible format
change, so `STORE_SCHEMA_VERSION` stays 1 with no migration. Working
discussion before freeze is still never persisted (no draft database, §30).

## Restart Recovery

Durable reopen is tested at every §39 matrix point: revisionless active
Section; ready checkpoint Proposal (exact hash survives); awaiting Proposal
with no approval (stays honest — no approval, no commit); checkpoint Proposal
+ durable Approval (retry commits cleanly); first checkpoint committed; second
checkpoint committed; downstream `needs_review` after a dependency revision.
After reopen, `currentRevision`/`approvedRevision`/`status`/`validation`/
contract/HEAD/snapshot are deep-equal to the pre-close state (§48 PRIMARY
below).

## Crash / Concurrency Validation

Real child-process crash probes (new `section-checkpoint` probe mode: real
completion commit → real DAG commit → freeze checkpoint → crash seam):

- **Pre-publication crash:** reopen shows zero checkpoint mutation (no
  revision, root still `pending/valid`, pointers undefined, HEAD at the DAG
  commit, Proposal `awaiting_approval`, Approval durable); the retry commits
  the whole checkpoint atomically.
- **Post-publication/pre-response crash:** reopen shows exactly one
  SectionRevision + one contract projection, root pointing at revision 1
  (`active`, `needs_review` — its dependency has no contract), one
  PlanCommit/Snapshot with the checkpointed root represented additively; the
  exact retry returns the same commit.
- **Concurrency (§41):** two durable instances on the same project both
  observe the revisionless root and freeze first-checkpoint Proposals
  (distinct PROP ids, same resulting revision 1); A commits first; B's commit
  fails via HEAD protection (`head_snapshot_mismatch`) — no second competing
  revision, no merge, no silent renumbering after user approval.

## Tests Added

`test/section-checkpoint.test.ts` (42 tests) covering brief §46 tests 1-43 and
54-57 plus the tool-surface gateway flow; `test/durable-crash.test.ts` +3
(§40 pre/post/control, tests 51-52). Updated where the frozen 2E1 semantics
supersede older pins, without weakening any invariant:

- `capabilities.test.ts` — matrix restructured for the THREE detail substates
  (+ `prepare_section_checkpoint`, completion/reopen now withheld in detail);
  new substate-resolution test;
- `transaction-engine.test.ts` test 25 — `approvedRevision` now follows the
  new checkpoint (documented refinement above); engine hostile-proposal
  coverage (`complete_section` dependency invariant) unchanged;
- `architecture-workflow.test.ts` test 29 — converted to the Phase 2E1
  phase-boundary test (section completion withheld in detail; nothing
  mutated); the engine-level completion semantics remain covered by the
  transaction-engine hostile tests;
- `section-decomposition.test.ts` tests 47/51 — completion now refused at the
  capability boundary (`capability_not_available`); L0 guidance assertions
  updated to the §31/§32 format;
- `parity-suite.ts`, `protocol-boundary.test.ts`, `authority-boundary.test.ts`
  — green unchanged (the change-vocabulary and completion-deferral boundaries
  hold).

## Live OpenCode Validation

`npm run smoke:opencode` extended honestly (brief §47): the headless runtime
CANNOT reach `detail + committed DAG` without interactive approvals, so the
full checkpoint flow remains an integration test on the controlled real tool
execution surface + ask stub (stated distinction). The smoke proves live:

1. `ultraplan_prepare_section_checkpoint` is registered on the real server
   (`/experimental/tool/ids`);
2. it refuses outside `detail/section-ready` with the structured
   `capability_not_available` error (the live run sits in architecture after
   the 2C vertical, mirroring the 2D decomposition-refusal check).

Result: see Verification Results.

## Verification Results

Scoped (`-w @switchboard/opencode`): `typecheck` 0 errors · `lint` clean ·
`test` **283/283 passed** (15 files: 42 new checkpoint tests + 12 crash tests
incl. 3 new §40 probes) · `build` emitted · `smoke:opencode` **20/20 checks
passed** (real `opencode serve`, real session, real ToolContext; both Phase
2E1 live checks green).

Root aggregate (exit codes verified, not piped tails):

- `npm run typecheck` — **pass** (0);
- `npm run lint` — **fail (exit 1), claude-code only**: 2 unused-variable
  errors in `adapters/claude-code/src/core/proposal-canonical.ts` /
  `proposal-normalize.ts` (its own concurrent in-flight workstream); the
  `@switchboard/opencode` lint is clean;
- `npm run build` — **pass** (0);
- root `npm test` — **fail (exit 1), claude-code only**: **7 failed / 262
  passed in 28 files** (store-migrations ×2, store ×1, store-migration-v4/v3/
  v2 ×1 each, store-multiprocess ×1 — its store/migration workstream,
  mid-change); `@switchboard/opencode` **283/283 green in 15 files**.

The root aggregate is therefore NOT green due to `adapters/claude-code`
exclusively; no Phase 2E1 file touches that workspace and it was left
untouched per the standing rule.

## Deviations From Frozen Architecture

None. The frozen architecture spec was not modified. Refinements stay inside
the spec's own "implementation-layer contract" allowance (§38):

- `Dependency.contractRevision?: number` — the spec references but does not
  define `Dependency`; the smallest coherent v0.1 shape was frozen (protocol
  §6.5);
- `approvedRevision` semantics on later checkpoints now move with the new
  approved revision (§17/§18) — the 2B behavior predated checkpoints;
- Phase 2E1 temporary narrowing: `request_completion(kind="section")` /
  `request_reopen` withheld in detail (protocol §4 note ³, §7.8) — recorded
  as the brief's own §19 requirement, to be lifted in Phase 2E2.

Amendment candidates for the architecture (none blocking): none identified —
the frozen `SectionRevision.projection.contract` embedding, the `Dependency`
shape, and the root status vocabulary all accommodated the workflow without
contradiction.

## Risks / Open Issues

- **activeWork is the only checkpoint target until 2E2.** The dependency-side
  revisions used in tests (§34/§36 flows) are crafted through the engine's
  amendment path because 2E1 has no focus switching; real flows will produce
  them after 2E2 adds progression. The engine's off-focus design_checkpoint
  guard (`checkpoint_scope_invalid`) is intentionally strict and may need a
  sanctioned 2E2 path for progression-driven checkpoints.
- **`provides`/`requires` are approved prose, not proofs** (brief §11's
  explicit fallback). Cross-section semantic verification would need the
  Validation phase machinery.
- **Completion invariant layer idle in detail:** `complete_section` staging +
  `assertSectionCanComplete` remain frozen and tested but are unreachable
  from tools until 2E2 (by design).

## Phase 2E2 Entry Conditions

```text
PlanningRun.stage = detail
DAG committed; sections SEC-### roots (some possibly active with revisions)
activeWork = a section focus
checkpoint machinery: add_section_revision (first) / amend_section (later)
validation = valid | needs_review derived from bound dependency contracts
completion/reopen capabilities withheld in detail (2E1 narrowing to lift)
```

Phase 2E2 implements: `section_completion` Proposal → dependency-completion
gate (`assertSectionCanComplete`) → `validation == valid` gate → user
Approval → PlanCommit → `Section.status = approved` → deterministic
next-work selection / focus transfer (commit-gated `activeWork` movement) →
all-Sections-approved detection → detail → synthesis transition.
