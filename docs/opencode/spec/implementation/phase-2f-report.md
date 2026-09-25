# Phase 2F Implementation Report

## Implemented

Phase 2F — Frozen Synthesis Input & Provenance-bound Synthesis Manifest
(`adapters/opencode/`, protocol v0.7). The entry state was the Phase 2E2 exit:
`stage = synthesis`, `activeWork = undefined`, every required Section
approved+valid with exact approved revisions and canonical contracts, and
`request_synthesis` withheld.

The vertical slice now works end to end:

```text
closed approved Detail state → exact HEAD Snapshot
      ↓ ultraplan_begin_synthesis (no model refs)
immutable, canonical-hashed SynthesisInput (deterministic capsule returned)
      ↓ planning model derives output over approved/frozen design only
ultraplan_submit_synthesis_manifest (derived content only)
      ↓ structural validation: provenance, cross-section rule, coverage, DAG order
immutable SynthesisManifest revision (SYN-###@n), stage stays synthesis
```

New modules: `src/synthesis/types.ts` (v0.1 shapes), `hash.ts` (canonical
hashes), `entry.ts` (§8 entry gate + §7 HEAD-anchored payload builder),
`validate.ts` (pure structural validation), `capsule.ts` (deterministic §21
capsule). Store API: `freezeSynthesisInput` / `getSynthesisInput` /
`listSynthesisInputs` / `getLatestSynthesisInput` / `saveSynthesisManifest` /
`getSynthesisManifest` / `getLatestSynthesisManifest` /
`listSynthesisManifests` (narrow, immutability-obvious — no
`updateSynthesisArtifact`/`replaceManifest`). Tools:
`ultraplan_begin_synthesis` + `ultraplan_submit_synthesis_manifest`.
plan_memory reads: `kind=synthesis_input` / `kind=synthesis_manifest`.
Durable: two additive document families with fail-closed loading; two new
audit events (`synthesis.input_frozen`, `synthesis.manifest_saved`).

## Synthesis Authority Boundary

- The planning model MAY organize approved design, normalize terminology,
  connect approved interfaces, derive implementation order, identify
  inconsistencies/missing design, and record limitations.
- It may NOT create Decisions/Constraints, change Architecture or Section
  design, invent interfaces, rewrite invariants, silently resolve gaps, commit
  memory, or finalize. No synthesis-path tool exists that could: the only new
  tools carry `derived_artifact` authority, and their input shapes cannot
  express design mutation (§35 — no `newDecisions`/`newConstraints`/
  `architectureChanges`/`approvedFacts`/`newInterfaces` fields exist).
- Test-proven (§61): `prepare_proposal` from synthesis →
  `capability_not_available`; manifest submission leaves committed artifacts,
  commit chain, HEAD, and stage byte-identical; `request_synthesis` remains
  granted nowhere (capability matrix pinned).

## Derived Artifact Authority

`ToolAuthority` gained `derived_artifact` (brief §5): "may create immutable
derived workflow artifacts, must never mutate committed Plan Memory." Both
synthesis tools carry it; `mutatesCommittedMemory` stays `false` by
construction; `proposal_intent` was NOT overloaded. Documented in the tool
inventory (protocol §3) and enforced by the same derived matrix machinery.

## SynthesisInput Contract

`SynthesisInput = { id: SYN-IN-###, planID, baseSnapshot: SnapshotRef,
baseCommit: CommitID|null, architecture: ArchitectureRef,
sections: FrozenSectionState[], decisions: DecisionRef[],
constraints: Constraint[], questions: FrozenQuestionState[],
conflicts: FrozenConflictState[], evidence: FrozenEvidenceState[],
createdAt, hash }` where `FrozenSectionState = { ref: {id, revision}, title,
dependencies }` — the adaptation of the brief's conceptual shape: section
entries carry the DAG edges (needed for §29 order validation) and titles
(needed for the capsule) alongside the exact revision ref.

## HEAD Snapshot Anchoring

The payload builder (`buildSynthesisAuthorityPayload`) reads ONLY the exact
HEAD Snapshot + the artifacts it binds: Architecture ref from
`snap.state.architectureRevision` (approved, must resolve), sections from
`snap.state.sectionRoots` in canonical order at `approvedRevision` (never
"latest"), decisions from `snap.state.decisionRevisions` (exact revisions,
sorted by id), constraints from `snap.state.constraintIDs` (frozen copies of
the identity-only records — no invented revisions), OPEN questions/conflicts
as frozen copies, evidence along the represented chain
(Architecture/SectionRevision → Decision → Evidence) at exact resolved
revisions. The store revalidates the §8 entry gates in-lock and refuses a
payload whose `baseSnapshot` ≠ current HEAD (`head_snapshot_mismatch`), so a
racing design change can never be frozen silently. An additional hostile-drift
gate cross-checks each live Section root against its snapshot root.

## Input Hash / Idempotency

Canonicalization = the proposal-hash contract (`stableStringify`: sorted
keys, undefined dropped, arrays semantic; SHA-256). INCLUDED: planID,
baseSnapshot, baseCommit, architecture, sections, decisions, constraints,
questions, conflicts, evidence. EXCLUDED: id, createdAt, hash — which makes a
repeated freeze at the same authoritative state byte-identical (§16/§17).
Golden hash pinned: `eae9176e5755bb249a9e36adc09bb695e400d6b5c55e44088cc934be52091042`;
a mutation matrix proves every authority-field change moves the hash.
Idempotency is a store-level, in-lock behavior (hash lookup → return the
existing input): the controller test proves the same SYN-IN-001 comes back;
the cross-instance test proves racing freezes converge on ONE canonical input.

## Stable Projection Inputs

No re-summarization at freeze or render time (§10/§11). The capsule renders
Section designs through their frozen `projection.compact` +
`projection.contract` read from the exact immutable revisions, and the
Architecture deterministically from its approved structured content
(summary/components/boundaries/dataFlows/principles). The byte-stability is
test-pinned (repeat render equality, including across a durable reopen).

## Relevant Evidence Capture

The only reachability the domain represents (§15): frozen Decisions → their
Evidence refs, resolved to exact revisions with confidence/criticality/
freshness/status. No repository scanning, no automatic promotion, no claim of
the global Evidence Audit. Frozen records are never mutated when live evidence
later changes (§52 test: a new EVD-002@2 leaves the frozen @1 state intact).

## SynthesisManifest Contract

`SynthesisManifest = { id: SYN-###, revision, input: {id}, baseSnapshot,
inputHash, architecture, sections, crossSectionLinks: DerivedStatement[],
implementationOrder: ImplementationStep[], limitations: DerivedStatement[],
unresolvedFindings: ValidationFinding[], createdAt, hash }`.
`ImplementationStep = { order (Harness-derived from array position), title,
description, sections: {id, revision}[], sources }`;
`DerivedStatement = { statement, sources }`;
`ValidationFinding = { category, statement, sources? }` with v0.1 categories
`contradiction | missing_design | missing_dependency | coverage_gap` — the
Phase 2G validator vocabulary (`unsupported_new_fact`, `incorrect_derivation`,
`clean`) is deliberately NOT unified here. Manifest hashes exclude
id/revision/createdAt/hash; golden hash pinned:
`6cf58984c6dcc19c8c2a15661f26df3b915a3fe5d5c9ed91646580e772b2d039`.

## Derived Statement Provenance

Every link/limitation/step REQUIRES ≥ 1 exact source
(`provenance_missing`); every source must resolve EXACTLY against the frozen
input authority sets (`provenance_invalid` — sections/decisions/evidence with
mandatory integer revisions; constraints/questions/conflicts by id).
Cross-section links require ≥ 2 DISTINCT Sections (`cross_section_invalid`).
Findings' sources are optional "where applicable" and may additionally cite
blockers raised AFTER the freeze (§53 — "input/current allowed state");
derived statements remain strictly input-bound (§25). All §59 cases are
explicitly tested (zero sources, outside-input, historical non-input revision,
current exact revision, exact decision ref, uncaptured evidence ref, 1-section
link rejected, 2-section link accepted).

## Implementation Order Validation

- Coverage (§28): every approved SectionRevision appears in ≥ 1 step
  (`implementation_coverage_gap`); duplicate participation across steps is
  PERMITTED by the documented rule (tested).
- DAG order (§29): for each Section with structural dependency D, the first
  step occurrence of D must be ≤ the Section's own first occurrence
  (`implementation_order_violation`); same-step grouping is accepted (tested).
  Validation is deterministic code — no LLM.
- Step identity: unknown Section refs and historical non-input revisions
  rejected (`provenance_invalid`); step numbers are Harness-derived; the
  model supplies no sequence field.

## Findings / Limitations Semantics

Findings are a detector/report only (§32): they reopen nothing, resolve
nothing, mutate nothing — and the schema cannot express it. Limitations are
derived statements with mandatory provenance. The four v0.1 categories are
enforced (`finding_invalid`); the model may raise real blockers through the
still-available `record_question`/`raise_conflict` (§32/§53) — tested: a
post-freeze question is citable by findings but not by derived statements.

## Structural vs Semantic Validation Boundary

Every surface says STRUCTURALLY valid, never "semantically validated":
status renders `Manifest status: structurally valid` +
`Semantic validation: not run`; the tool output and L0 protocol repeat the
boundary; §34's non-claims (no unsupported-fact/contradiction/derivation
proofs) are documented in the protocol and code comments. Phase 2G owns the
semantic validator; the manifest hash is its identity input.

## Manifest Revision / Idempotency Semantics

One stable manifest identity per SynthesisInput with Harness-assigned
contiguous revisions (SYN-001@1 → @2; tested). Exact-content resubmission
returns the existing revision (`idempotent: true` signaled to the caller);
different content creates the next revision; resubmitting OLD content after a
newer revision replays the exact old revision — never a meaningless duplicate
and never a mutation of @1 (all §37 cases tested).

## Capability Matrix

`synthesis` now resolves into THREE structured substates from the latest
derived artifacts (resolved by `authorizeTool` from the store):

| Substate | Grants (beyond lifecycle reads) |
|---|---|
| synthesis/no-input | record_question, propose_question_resolution, raise_conflict, **begin_synthesis** |
| synthesis/input-ready | the same + **submit_synthesis_manifest** |
| synthesis/manifest-ready | the same (manifest revisions are supported) |

`begin_synthesis` is granted in EVERY synthesis substate deliberately
(documented deviation-note in the matrix rationale): §17 requires a repeated
freeze to return the SAME input rather than be denied, and only a fresh freeze
can replace a stale input after a future HEAD change (§18/§51). The withheld
list is unchanged and test-pinned: `request_synthesis`, `request_reopen`,
`prepare_proposal`, decomposition/checkpoint/completion/focus operations are
all absent from every synthesis substate. Matrix pinned in
`test/capabilities.test.ts` (all three synthesis variants) and mirrored in
protocol §4 (v0.7).

## Plan Memory Reads

`plan_memory` supports `kind=synthesis_input` (exact id — historical inputs
never resolve to latest; the id IS the identity) and
`kind=synthesis_manifest` (id + optional revision: with revision an exact
historical read whose miss is an error, without it the newest revision of that
id). The two kinds ride dedicated result-ref shapes (they are not committed
Plan Memory, so they are not part of the `MemoryRef` union and cannot be
attached to conflicts/proposal refs). The current active input/manifest is
discoverable from status and the L0 projection (§46).

## Durable Representation

Two additive `StoreDocument` families: `synthesisInputs` (planID →
`SYN-IN-###` → record) and `synthesisManifests` (planID → `SYN-###@REV` →
record, insertion-ordered for latest resolution). **Schema version stays 1**
(§39 reasoning): both families are optional; absence in a pre-2F document has
the unambiguous semantics "no synthesis was ever performed"; all record shapes
are self-contained JSON with recomputable hashes — no existing family changed,
no migration needed. Fail-closed loading (§40): stored hashes must recompute
(input payload and manifest content, exact same canonicalization as
`synthesis/hash.ts` — imported, not duplicated); a manifest's input must exist
and be mirrored exactly (baseSnapshot/architecture/sections/inputHash);
revision chains per id must be contiguous 1..n with key/identity agreement;
provenance refs must use supported exact forms. No auto-repair anywhere.

## Restart Recovery

The §57 matrix is fully covered close/reopen at: synthesis/no-input, frozen
input/no manifest, manifest@1, manifest@2, and stale input after a HEAD
change — after each reopen the inputs, manifests, hashes, baseSnapshot,
HEAD pointers are deep-equal to the pre-close state. Fail-closed loading is
exercised by the corruption suite (below), which also proves hashes are never
silently recalculated-and-replaced.

## Crash / Concurrency Validation

- Crash probes (§56) run as REAL child processes (new `crash-probe.mjs` modes
  `synthesis-freeze` / `synthesis-manifest`; the derived-artifact writes are
  driven through the real controller with the durable store and the shared
  `armCrashSeam` commit point — no PlanCommit/HEAD involved):
  - freeze before-persist → zero inputs, zero manifests, commit chain
    unchanged (COMMIT-008); retry freezes SYN-IN-001;
  - freeze after-persist → exactly one input + one `synthesis.input_frozen`
    event; retry returns the SAME input;
  - manifest before-persist → input intact, zero manifests; retry saves
    SYN-001@1;
  - manifest after-persist → exactly one revision, HEAD still COMMIT-008;
    exact resubmission is idempotent;
  - clean controls print `PROBE-INPUT SYN-IN-001 BASE=SNAP-009
    STAGE=synthesis HEAD=COMMIT-008` and `PROBE-MANIFEST SYN-001@1
    INPUT=SYN-IN-001 STAGE=synthesis HEAD=COMMIT-008`.
- Cross-instance concurrency (§55): two DurablePlanStores freezing the same
  state concurrently converge on ONE canonical input (same id/hash, list
  length 1 on both); competing different manifests serialize into @1/@2 with
  one stable identity (no revision collisions); two identical manifests are
  idempotent. Safety comes from the existing O_EXCL lock + rehydrate-under-lock
  plus the in-lock entry/staleness revalidation.

## Corruption / Fail-closed Validation

All §58 cases, each failing `store_corrupt` at OPEN with no repair: tampered
SynthesisInput hash; tampered Manifest hash; manifest referencing a missing
input; manifest architecture ≠ input's; manifest Section set ≠ input's;
malformed provenance ref (section source without revision); broken revision
chain (@2 without @1).

## Tests Added

`test/synthesis.test.ts` — 35 tests: golden input/manifest hashes + mutation
matrices (§16/§38); freeze preconditions and entry gates (§8); exact-ref
binding of architecture/sections/decisions/constraints (§7/§9/§12/§13);
frozen blockers + evidence capture and frozen-evidence immutability
(§14/§15/§52); idempotent re-freeze (§17); deterministic capsule (§21);
manifest identity/step-order/binding (§22/§24/§27); §59 provenance set;
cross-section rule (§26); coverage + duplicate participation (§28); DAG
order + same-step grouping (§29); findings categories + post-freeze blocker
citation (§31/§53); revision idempotency/replay (§36/§37); staleness + input
survival (§18/§50); normative boundary incl. zero PlanCommits/HEAD movement
and withheld request_synthesis (§61/§43); derived-artifact reads (§41);
status three-state rendering + stale line (§47); L0 projection (§45/§46);
durable PRIMARY (§62), restart matrix (§57), corruption set (§58),
cross-instance concurrency (§55), compaction-independence (§63).

`test/durable-crash.test.ts` — 5 tests (§56): freeze pre/post crash, manifest
pre/post crash, clean controls.

`test/capabilities.test.ts` — synthesis matrix rewritten for the three
substates; withheld-capability pinning extended (begin/submit declared and
granted; request_synthesis/request_reopen granted nowhere).
`test/section-completion.test.ts` — test 60 updated from the 2E2 placeholder
pin to the real Phase 2F authority guidance pin (§45), byte-stability kept.

## Live OpenCode Validation

Live/integration split (stated exactly per §64): on a real `opencode serve`
process with the built plugin, the smoke proves `ultraplan_begin_synthesis`
and `ultraplan_submit_synthesis_manifest` are REGISTERED in the runtime tool
surface and both REFUSE with structured `capability_not_available` outside
valid Synthesis state (the smoke run sits in architecture). **27/27 checks
passed (exit 0).** The full Synthesis vertical (freeze → manifest) remains
integration-tested with controlled setup: headless smoke cannot drive the
interactive Detail approvals (architecture proposal, decomposition, three
checkpoint+completion approval cycles) without a real user at the ask
boundary — faking that would violate the no-fake-validation rule. The crash
probes provide the process-level proof of the durable derived-artifact path.

## Verification Results

Real producer exit codes (`npm run <script> -w @switchboard/opencode`, root
aggregate separate; no pipelines masking failures):

| Check | Result |
|---|---|
| `typecheck` (opencode) | exit 0 |
| `lint` (opencode) | exit 0 |
| `test` (opencode) | exit 0 — **373/373 tests, 17 files** (333 pre-existing + 40 new) |
| `build` (opencode) | exit 0 |
| `smoke:opencode` | exit 0 — 27/27 live checks |
| `typecheck` (root) | exit 0 |
| `lint` (root) | exit 0 |
| `test` (root) | exit 0 — claude-code **405/405 (41 files)** + opencode **373/373 (17 files)** |
| `build` (root) | exit 0 |

Root aggregate is fully green this phase with true producer exit codes
(previous phases' claude-code lint/EPIPE failures were resolved by the
concurrent session; this phase did not touch `adapters/claude-code` — the two
`[phase-plan]` hook-noise lines in the root test log are that workstream's
hook environment, not test failures).

## Deviations From Frozen Architecture

None against the frozen architecture document — it was not modified. The
spec-referenced-but-undefined types (`ImplementationStep`, `DerivedStatement`,
`ValidationFinding`) were frozen as the smallest coherent v0.1 shapes required
by Synthesis (per brief §2), placed in the implementation-layer
`src/synthesis/` module rather than the spec directory. Documented
implementation-layer choices: (a) `begin_synthesis` granted in every synthesis
substate (§17 idempotency + stale-input replacement — see Capability Matrix);
(b) the SynthesisInput section entries carry `title` + `dependencies` next to
the exact ref (needed by §29 order validation and §21 capsule — an adaptation
of the conceptual shape, permitted by brief §6 "adapt this to the real domain
model"); (c) finding sources may consult post-freeze blockers per §33's
"input/current allowed state" while derived statements stay strictly
input-bound per §25.

## Risks / Open Issues

- Semantic validity is NOT established by Phase 2F — a structurally valid
  manifest can still contain unsupported statements; the Phase 2G validator is
  the gate, and its identity input (manifest hash) is already bound.
- Stale-input recovery in synthesis is intentionally narrow: a fresh freeze
  works, but the real reopen path (Detail amendment → new SynthesisInput →
  new Manifest) arrives with the Phase 2G reopen-admission workflow (§51).
- The manifest idempotency/revision model keys on canonical content; two
  different-but-equivalent renderings of the same semantics create two
  revisions — acceptable for v0.1 (the validator consumes the current
  revision; history stays immutable).
- `SynthesisInput` freezes OPEN questions/conflicts only; resolved history
  remains in Plan Memory reads. If 2G needs resolved-state context, the input
  shape can extend additively (hash contract documents the payload).

## Phase 2G Entry Conditions

```text
PlanningRun.lifecycle = active, stage = synthesis
SynthesisInput frozen from an exact HEAD Snapshot (id, hash, baseSnapshot)
SynthesisManifest revision(s) exist, structurally valid, provenance-bound;
  manifest hash available as the validator identity input
plan_memory serves exact synthesis_input / synthesis_manifest reads
request_synthesis still withheld; no synthesis → final transition exists
```

Phase 2G — Read-only Semantic Validation & Reopen Admission — consumes the
frozen input + exact manifest, produces the structured ValidationReport
(`unsupported_new_fact | contradiction | missing_design | missing_dependency |
incorrect_derivation | coverage_gap | clean`), and owns the clean-gate /
reopen-request flow. Not started in this phase.
