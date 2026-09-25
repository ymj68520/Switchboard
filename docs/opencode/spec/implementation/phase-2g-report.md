# Phase 2G Implementation Report

## Implemented

Phase 2G — Read-only Semantic Validation & Section Reopen Admission
(`adapters/opencode/`, protocol v0.8). The entry state was the Phase 2F exit:
`stage = synthesis`, an immutable HEAD-anchored SynthesisInput, immutable
structurally-valid SynthesisManifest revisions with exact provenance, and
`request_synthesis` withheld.

The vertical slice now works end to end:

```text
Frozen SynthesisInput + exact SynthesisManifest@n
      ↓ ultraplan_run_semantic_validation (model supplies NOTHING)
Harness resolves the exact pair → single-flight admission → isolated
read-only validator (semantic-validation:v1) → strict JSON parsing →
structural report validation → immutable canonical-hashed ValidationReport
      ├── clean  → synthesis remains; semantic-validation eligibility recorded
      └── findings → synthesis blocked
            ↓ ultraplan_request_reopen (exact section + finding ids)
amendment Proposal (closed reopen_section change) → USER approval
            ↓
reopen_section PlanCommit: approved → reopened, validation → needs_review,
stage synthesis → detail, activeWork → target
            ↓
normal Detail loop: checkpoint N→N+1, re-completion, downstream review,
detail → synthesis → new input/manifest/report identity
```

New module `src/validation/`: `types.ts` (report/finding/admission contracts),
`protocol.ts` (frozen `semantic-validation:v1` prompt), `capsule.ts`
(deterministic §14 capsule), `parse.ts` (strict JSON, §17), `validate.ts`
(structural report validation, §13/§23), `hash.ts` (canonical report hash),
`opencode-validator.ts` (runtime adapter). Store: `saveValidationReport` /
`getValidationReport` / `getCurrentValidationReport` / `listValidationReports`
/ `findValidationReportByIdentity` / `admitSemanticValidation` /
`releaseSemanticValidation` / `getSemanticValidationAdmission` (no
update/replace — reports are immutable). Transaction: the closed
`reopen_section` change (NOT in the generic proposal vocabulary). Tools:
`ultraplan_run_semantic_validation` + the narrow rewrite of
`ultraplan_request_reopen`. plan_memory: `kind=validation_report`. Durable:
two additive document families with fail-closed loading; one new audit event
(`validation.report_saved`).

## Semantic Validation Authority

The validator is a DETECTOR ONLY (brief §5): it classifies the six non-clean
categories plus clean; it may not create/commit/write/resolve/reopen/finalize.
These restrictions are structural — the wire and record shapes cannot express
any mutation, and the core depends only on the narrow `SemanticValidator`
interface; nothing model-facing implements it. A ValidationReport is a durable
derived artifact: zero PlanCommits, zero Snapshots, zero HEAD movement, zero
committed design mutation, no stage change (§54) — test-proven for both
results. `plan_memory` reads reports by EXACT id only (§59); the current
report is discoverable from status/L0.

## OpenCode Validator Runtime Boundary

Verified against the installed `@opencode-ai/plugin` 1.18 types and the
generated `@opencode-ai/sdk` surface the plugin input binds: `PluginInput`
carries a bound `client` (OpencodeClient), and `session.prompt` accepts
per-request `system`, `tools`, and `model`. The adapter
(`validation/opencode-validator.ts`) opens ONE ephemeral Harness-owned
session, sends ONE prompt (protocol system prompt; the capsule as the only
user content), extracts the text parts, deletes the session. No child-session
API beyond the verified `session.create`/`session.prompt`/`session.delete`
triple is assumed; no generic subagent orchestration was built.

## Validator Protocol / Isolation

Frozen protocol `semantic-validation:v1` (`validation/protocol.ts`), stored in
every report; changing validator semantics requires a new protocol version
(new validation identity). Isolation is STRUCTURAL, not prompt-based:

- the validator session is NOT the PlanningRun owner — every harness tool in
  that session resolves no run and fails `no_active_run`; the validator cannot
  become workflow authority;
- defense-in-depth: the per-request tools map disables all `ultraplan_*`
  tools plus the standard repository/shell builtins (mutation, approval,
  repository-write AND read tools — the frozen capsule is the only input);
- documented limit (stated per §8/§10): the v1.18 tools map disables tools BY
  NAME — no verified "disable-all" wildcard exists, so an unknown
  third-party tool name would not be covered by the map. The structural
  session-boundary guarantee does not depend on the map.
- the ephemeral session is Harness-owned, validator-only, read-only, not user
  planning state, not used for planning continuity, not a writable PlanningRun
  owner (§9).

## Validation Capsule

`buildValidationCapsule(store, input, manifest)` renders the deterministic §14
capsule: input identity/hash/base snapshot; exact Architecture content; FULL
approved SectionRevision bodies (problem/design/interfaces/invariants/
failureModes/dependency bindings/compact projection/contract — §15 permits
full content; the Context Assembler is still NOT implemented); exact approved
Decisions; committed Constraints; frozen Question/Conflict state; frozen
Evidence state; the exact manifest revision/hash with its crossSectionLinks,
implementationOrder, limitations, unresolvedFindings. Byte-stable for
identical frozen state; no raw conversation is included.

## ValidationReport Contract

`ValidationReport = { id: VAL-###, planID, input: {id}, inputHash,
manifest: {id, revision}, manifestHash, baseSnapshot, validatorProtocol,
validatorModel?, result: clean|findings, findings: SemanticValidationFinding[],
createdAt, hash }`. `SemanticValidationFinding = { id: VF-### (Harness-
assigned), category, statement, scope: {architecture?, sections?},
manifestItem?: closed locator, sources }` — the §20 conceptual shape adapted
to the real ref types (scope refs are exact `{id, revision}` section refs;
manifest-item locators are the four closed forms with 1-based indices /
existing step orders; NO JSONPath, no arbitrary paths). `clean` is a report
RESULT, never a finding category (§19).

## Strict Parsing

Hand-rolled recursive-descent JSON parser (JSON.parse silently keeps duplicate
keys): rejects markdown fences, leading/trailing prose, embedded JSON,
duplicate keys, unknown fields (top-level and per-finding), validator-supplied
finding ids, NaN/Infinity, wrong enums, wrong types, empty required strings,
malformed refs/locators, and any trailing content. NO permissive fallback
extraction. Every rejection is `validation_output_invalid` — an EXECUTION
FAILURE (§26): nothing is persisted and retry is allowed; it is never
converted into a findings report.

## Semantic Finding Semantics

Six categories frozen (`SEMANTIC_FINDING_CATEGORIES`); every finding must
identify an affected scope (Architecture ref and/or ≥1 exact section ref, §22);
`unsupported_new_fact | incorrect_derivation | contradiction` findings carry
exact source refs where supplied, and ALL supplied refs must resolve exactly
against the current SynthesisInput (strictly input-bound — findings are not
manifest statements, so post-freeze blockers are NOT citable here). The
Harness assigns finding ids VF-001..n in report order; the validator never
names them. The §13 rule is enforced at parse-validation AND at durable load:
a manifest declaring `unresolvedFindings` makes `clean` invalid — semantic
validation cannot erase a synthesis-declared unresolved finding.

## Report Hash / Idempotency

Canonicalization is the shared contract (stableStringify: sorted keys,
undefined dropped, arrays semantic; SHA-256). INCLUDED: planID, input
ref+hash, manifest ref+hash, baseSnapshot, validatorProtocol,
validatorModel (when recorded), result, findings (including Harness-assigned
ids — category/statement/scope/manifestItem/sources). EXCLUDED: id, createdAt,
hash (the existing derived-hash convention, §24). Golden hash pinned:
`286dc2a5755d46ab1123af6df8921841961e2bd9698355d48e3309f95bfc373b`; a
mutation matrix proves every semantic content change moves the hash. The same
recompute runs at durable load (fail closed).

## Anti-laundering Rule

Validation identity = (inputHash, manifestHash, validatorProtocol) — ONE
exact input + ONE exact manifest revision under ONE protocol. Once a
successful report exists for an identity, `run_semantic_validation` returns
it with `idempotent: true` and the validator is NOT invoked (fast path +
store-level in-lock check, both tested). A findings report cannot be
"rerolled": a new judgment requires a genuinely changed design or manifest
revision (new identity — tested end to end: revised manifest @2 → validator
invoked again → VAL-002). Changing the validator protocol later is likewise a
new identity.

## Durable Validation State

Two ADDITIVE `StoreDocument` families: `validationReports` (planID →
VAL-### → record) and `validationAdmissions` (planID → identityKey →
admission). **Schema version stays 1** (§28 reasoning): a pre-2G document
without `validationReports` unambiguously means "semantic validation has
never run"; no existing family is reinterpreted; all record shapes are
self-contained JSON with recomputable hashes. Fail-closed loading (§29):
report hash recomputes; input and manifest exist and are mirrored exactly
(inputHash, manifestHash, baseSnapshot, manifest-belongs-to-input); result
enum + clean/findings cardinality + the §13 clean-with-unresolved-findings
rule; finding category/statement/id shape; exact scope resolution (sections
∈ input sections, architecture revision match); manifest-item bounds; source
refs resolve against the input; admission records carry well-formed
identities and expiry after admission. No auto-repair anywhere.

## Capability Matrix

`synthesis` now resolves into FIVE structured substates
(`CapabilityContext.synthesis.report` = the successful report bound to the
CURRENT input+manifest identity; reports on superseded identities pick no
substate):

| Substate | Grants (beyond lifecycle reads) |
|---|---|
| synthesis/no-input | record_question, propose_question_resolution, raise_conflict, begin_synthesis |
| synthesis/input-ready | the same + submit_synthesis_manifest |
| synthesis/manifest-ready, unvalidated | the same + run_semantic_validation |
| synthesis/validation-findings | + request_reopen (restored narrowly) |
| synthesis/validation-clean | the unvalidated surface (begin/submit/validation idempotent), NO request_reopen, NO design mutation restored |

`request_reopen` is also restored in BOTH detail section-ready substates for
the dependency-review loop (§49/§50). `request_synthesis` remains granted
NOWHERE (§55) — a clean report never gates synthesis → final. Matrix pinned
in `test/capabilities.test.ts` (all five synthesis variants + both detail
reopen grants) and mirrored in protocol §4 (v0.8).

## Clean-state Semantics

A clean report proves ONLY the semantic-validation component (§4/§55). Phase
2G does NOT call `checkFinalization` on clean, does NOT expose FinalPlan
creation, does NOT implement synthesis → final, and keeps `request_synthesis`
withheld. The validation-clean surface restores no design mutation. Status
renders `Finalization: not run`; `Final: ready` is never rendered (§57,
tested).

## Section Reopen Admission

`ultraplan_request_reopen` (narrow rewrite; §37/§41): the model names a
target Section and, in synthesis, the report's finding ids — never status,
revision, validation, or stage. Harness gates:

- synthesis: the CURRENT ValidationReport must be `findings`
  (`validation_report_missing` otherwise); target approved with agreeing
  pointers; unknown finding ids `unknown_reference`; ≥1 selected finding must
  affect the EXACT target SectionRevision, else `reopen_target_unsupported`
  (§53 — Architecture-level findings remain blocking and are never mapped to
  an arbitrary section; architecture reopen is recorded below as an explicit
  limitation);
- detail (dependency_review, §49/§50): target approved AND
  `validation = needs_review`; findingIDs must be absent; no report required;
- elsewhere: capability gate (`capability_not_available`).

The frozen intent is the closed `reopen_section` change binding the exact
Harness-resolved target revision, the report id+hash, and the exact finding
ids — inside the `amendment` Proposal hash (§40/§42). The approval view
renders the deterministic SECTION REOPEN projection (§43). The generic
`prepare_proposal` vocabulary cannot express `reopen_section`
(`proposal_kind_unsupported`), and the engine independently revalidates type
(`reopen_type_invalid`), scope (`reopen_scope_invalid`), stage
(`reopen_stage_invalid`), target state (`reopen_target_invalid`), report
binding/currency (`reopen_report_mismatch` / `reopen_report_stale`), and
finding coverage (`reopen_reason_invalid` / `reopen_target_unsupported`) for
hostile direct calls.

## Reopen Proposal / Approval

`request_reopen` → `amendment` Proposal (type unchanged per §42), scoped to
the exact SectionRef, frozen and hashed via the standard pipeline; approval
persistence is crash-safe (the Approval is durable while the proposal stays
`awaiting_approval` until the commit). Rejection leaves the Section approved
and the stage untouched (tested). The §43 approval view is a pure projection
of the frozen change (section, exact revision, report id/hash, cited
findings with categories, deterministic effect lines) — no post-freeze model
prose.

## Reopen PlanCommit Semantics

One atomic `reopen_section` PlanCommit (§44): status approved → reopened;
validation → needs_review; `currentRevision`/`approvedRevision` unchanged; NO
new SectionRevision (§45 — the approved revision and its contract stay
immutable and byte-identical, tested); stage synthesis → detail (semantic
reopen) or stays detail (dependency review); activeWork → the exact target;
Snapshot + PlanCommit + HEAD published together. Downstream propagation is
deliberately NOT done by the reopen — it happens when the reopened section's
new revision/contract commits, reusing the unchanged `propagateNeedsReview`
(§48, tested). Old reports/findings remain historical — never marked
"resolved" (§51, tested).

## Dependency-review Reopen

§49/§50/§71 covered end to end with real flows: the approved+needs_review
state arises organically (an amended upstream contract propagates needs_review
onto approved downstream sections); `request_reopen` (no findingIDs) →
approval → commit sets reopened/focus/stage-stays-detail; the revalidated
checkpoint binds the new upstream contract and restores `valid`; no direct
`mark_valid` tool exists (matrix-pinned). This works WITHOUT a fresh semantic
ValidationReport (the old report's identity is stale by then — tested).

## Return-to-Synthesis Cycle

Reopened sections checkpoint through the EXISTING
`prepare_section_checkpoint` flow (§46 — a reopened root is amendable; its
amendment returns the root to `active`, §47) and re-complete through the
existing completion gates; the §76 primary test drives the FULL loop:
findings → reopen SEC-002 → checkpoint @2 → downstream SEC-003 needs_review →
dependency-review reopen SEC-003 → checkpoint @2 → re-focus → completions →
synthesis → `begin_synthesis` (SYN-IN-002) → revised manifest → NEW
validation identity → validator invoked again → clean VAL-002, with all old
artifacts intact (§52). The premature completion (SEC-002 while SEC-003 is
still needs_review) fails the all-approved-but-invalid synthesis-entry gate
deterministically — the §49 reopen is the sanctioned route out.

## Architecture-level Finding Limitation

Per §38/§53: Phase 2G implements SECTION reopen only. An Architecture-level
finding keeps the report blocking; a Section reopen attempt against it fails
`reopen_target_unsupported`; architecture reopen semantics (and any
Architecture amendment machinery beyond the initial `add_architecture` path)
remain explicit later-phase work. Recorded in the protocol (§7.12) and
tested.

## Restart Recovery

§74 covered close/reopen at: manifest-ready/unvalidated; findings report;
clean report; reopen Proposal (ready); reopen Proposal + DURABLE approval
(proposal still `awaiting_approval`); committed reopen (reopened section /
stage=detail / focus). The durable test asserts whole-document deep-equality
across a read-only reopen (identities/hashes/findings survive exactly) and
commits the durable approval from a NEW store instance.

## Crash / Concurrency Validation

- Crash probes (§62/§63) run as REAL child processes (new `crash-probe.mjs`
  modes `semantic-validation` / `reopen`, driven through the real controller
  with a deterministic fake validator):
  - validation before-persist dies on the ADMISSION write → NO report, the
    dead process's durable admission is RECLAIMED by the next process
    (different pid — §32), retry publishes exactly one findings report;
  - validation after-persist → exactly one report + one
    `validation.report_saved` event; retry returns the SAME report via the
    anti-laundering lookup (validator not invoked);
  - reopen before-persist → Section still approved, stage synthesis,
    activeWork absent, Approval durable, HEAD COMMIT-008; retry commits once
    (§63 pre);
  - reopen after-persist → Section reopened exactly once, stage detail,
    activeWork target, one Snapshot, one PlanCommit, HEAD COMMIT-009 exact;
    idempotent retry (§63 post);
  - clean controls print `PROBE-VALIDATION VAL-001 RESULT=findings …` and
    `PROBE-REOPEN SEC-002 STATUS=reopened … HEAD=COMMIT-009`.
- Single-flight (§30/§31): the durable lock is never held across the model
  call — admission registers under the lock, inference runs unlocked, the
  report persists under the lock with full identity revalidation. A live
  same-process double-admission fails `validation_already_running`; release
  (finally) makes retry possible.
- Cross-instance convergence (§64): two racing persists of DIFFERENT reports
  for the SAME identity converge — the second returns the first
  (`created: false`); exactly one report exists.

## Corruption / Fail-closed Tests

All §75 cases fail `store_corrupt` at OPEN with no repair: tampered report
hash; report referencing a missing input; missing manifest; wrong inputHash;
wrong manifestHash; wrong baseSnapshot; unsupported finding category; finding
citing a non-input section revision; invalid manifest-item locator; clean
report carrying findings.

## Tests Added

`test/validation.test.ts` — 35 tests: strict parser set (§17/§67); structural
output validation incl. §13; hash golden + mutation matrix (§24); §76 part 1
(findings report, zero mutation, capsule contents) and §77 (clean); §66
anti-laundering + new-identity revalidation; §26 execution-failure
distinction; §10 `validator_unavailable` honesty + §12 staleness; §59 exact
reads; §57 four status states (never `Final: ready`); §58 L0 fragments
verbatim; §69 admission matrix (1-18 incl. engine-level hostile target,
rejection safety, retry idempotency); §53 architecture-finding blocking; §41
report/finding gates; §70/§47/§48 reopened checkpointing with downstream
propagation; §71 dependency-review reopen without a fresh report; §30/§31
admission refusal; §64 racing-persist convergence; §74 restart matrix
(durable); §75 corruption set (durable).

`test/durable-crash.test.ts` — 5 tests (§62/§63): validation pre/post crash,
reopen pre/post crash, clean controls.

`test/capabilities.test.ts` — synthesis matrix rewritten for the FIVE
substates; `run_semantic_validation` added; request_reopen pinned in the two
detail section-ready substates + synthesis findings substate and nowhere
else; `request_synthesis` still withheld everywhere.

`test/section-completion.test.ts` — test 60 extended with the §58 fragments
(unvalidated / findings / clean) and the validation/reopen checklist pins;
byte-stability kept. `test/authority-boundary.test.ts` / `test/
section-checkpoint.test.ts` — the 2E2-era reopen-pins updated to the 2G
capability surface (decomposition-needed still withholds reopen; a pending
revisionless target now fails with the precise `invalid_scope`).

## Live OpenCode Validation

Live/integration split (stated exactly per §78): on a real `opencode serve`
process with the built plugin, the smoke proves `ultraplan_run_semantic_validation`
and `ultraplan_request_reopen` are REGISTERED in the runtime tool surface and
both REFUSE with structured `capability_not_available` outside their valid
states (the smoke run sits in architecture; reopen additionally requires the
detail section-ready substates). **31/31 checks passed (exit 0).** A REAL
semantic-validation inference was NOT performed live: reaching synthesis
headlessly requires the interactive Detail approval cycles (architecture
proposal, decomposition, three checkpoint+completion approval cycles) that
cannot be satisfied without a real user at the ask boundary — faking that
would violate the no-fake-validation rule. The full semantic vertical is
integration-tested with deterministic fake validators and process-level
crash probes; the OpenCode validator adapter is implemented strictly against
the verified SDK surface (typed client in `PluginInput`; `session.prompt`
`system`/`tools` parameters).

## Verification Results

Real producer exit codes (`npm run <script> -w @switchboard/opencode`, root
aggregate separate; no pipelines masking failures):

| Check | Result |
|---|---|
| `typecheck` (opencode) | exit 0 |
| `lint` (opencode) | exit 0 |
| `test` (opencode) | exit 0 — **413/413 tests, 18 files** (373 pre-existing + 40 new) |
| `build` (opencode) | exit 0 |
| `smoke:opencode` | exit 0 — 31/31 live checks |
| `typecheck` (root) | exit 0 |
| `lint` (root) | exit 0 |
| `test` (root) | first run exit 1 — `adapters/claude-code` `test/proposal-concurrency.test.ts` lost a REAL multi-process race (`STORE_OPEN_FAILED` instead of `PROPOSAL_ALREADY_AWAITING`); green in isolation (3/3) and on the full re-run: **exit 0 — claude-code 409/409 (42 files) + opencode 413/413 (18 files)** |
| `build` (root) | exit 0 |

The claude-code adapter is untouched by this phase (`git status` clean for
that workspace); the first-run failure is a timing-sensitive real-process
race in that workstream's suite (a child process failed to open the store
under lock contention within its bounded wait), not a semantic regression —
both workspaces pass on the retry with true exit codes.

## Deviations From Frozen Architecture

None against the frozen architecture document — it was not modified. The
§18 conceptual `ValidationReport` shape was adapted to the real domain (exact
refs, Harness-assigned finding ids, closed manifest-item locators) as the
brief permits. Documented implementation-layer interpretations: (a) manifest
REVISIONS remain available in the validation-findings substate — §66's "new
Manifest revision Y → new validation identity" requires it, and it can never
re-roll an existing report (§25); (b) manifest-item locator indices are
1-based, matching the Harness-derived step `order` convention; (c) finding
sources are strictly input-bound (§23's exact-resolution rule — findings
cannot cite post-freeze blockers, unlike manifest findings per 2F §53); (d)
the per-request tools map disables tools by name (verified surface) — the
structural isolation guarantee is the session/run-ownership boundary.

## Risks / Open Issues

- The validator prompt is inert guidance; enforcement is structural. A
  hostile/failed validator can at worst produce a rejected execution or a
  structurally-valid-but-wrong findings report — a false "clean" additionally
  requires passing §13 (impossible with declared unresolved findings) and the
  strict schema; semantic correctness itself remains validator authority by
  design.
- The admission lease reclaims by pid + expiry (10 min default). A same-pid
  hung inference (no timeout wrapper on the model call in v0.1) holds the
  identity until expiry; no lock is held, so nothing else wedges.
- Architecture-level findings have no sanctioned repair path yet (reopen
  targets Sections only) — recorded as the §38 limitation; reports stay
  blocking by design until the architecture-amendment phase.
- `checkFinalization` is intentionally UNCHANGED and unused by 2G (§56): it
  still lacks the current-clean-report term, exact manifest identity,
  Evidence Audit state, and derived-artifact staleness checks; wiring those
  into the real deterministic Finalization gate is Phase 2H work.

## Phase 2H Entry Conditions

```text
stage = synthesis with a clean ValidationReport bound to the CURRENT
  SynthesisInput + SynthesisManifest identity (non-stale, hashes recompute)
the anti-laundering identity machinery (inputHash+manifestHash+protocol)
  available as the Finalization gate's validation term
request_reopen restored for findings → the sanctioned correction loop
`checkFinalization` unchanged (legacy) — Phase 2H replaces it with the
  deterministic Finalization Gate consuming: current clean report + exact
  input/manifest identity + current HEAD + full reachable Evidence audit +
  live blocking questions/conflicts → FinalPlan Candidate → Final Approval
request_synthesis still withheld; no synthesis → final transition exists
```

Phase 2H — Evidence Audit, Deterministic Finalization Gate & Final Plan
Candidate — is the expected next phase. Not started in this phase.
