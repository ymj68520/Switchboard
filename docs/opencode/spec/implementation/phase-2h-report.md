# Phase 2H Implementation Report

## Implemented

Phase 2H — Evidence Audit, Deterministic Finalization Gate & Final Plan
Candidate. Entry state (`stage = synthesis`, clean ValidationReport bound to
the CURRENT input+manifest identity, `request_synthesis` withheld) extended
with the real deterministic finalization pipeline:

- `ultraplan_request_finalization` (model-facing, accepts NOTHING — §4);
- `buildEvidenceAudit` → `evaluateFinalizationGate` → candidate freeze
  (preferred separation, §3; no model call anywhere);
- the immutable `EvidenceAuditSnapshot` and `FinalPlanCandidate` derived
  artifacts (durable, canonical-hashed, exact-ref-bound);
- the sixth synthesis capability substate `final-candidate-ready`.

NOT implemented (deferred by the brief): Final user Approval, Final
PlanCommit, `handoff_pending`, execution-model switch, ExecutionHandoff,
`PlanningRun` completion. The frozen architecture spec was not modified; no
contradiction requiring an amendment was found (the architecture's §30 rules
are implemented verbatim; the one open item — the frozen stage union's
synthesis → final edge — is exercised by nothing in 2H and remains for
Phase 2I).

## Evidence Audit Authority

- One finalization authority: the legacy `checkFinalization`
  infrastructure placeholder (core/invariants.ts) is DELETED; its only
  caller (`requestSynthesis`, the withheld provisional shortcut) now
  delegates to `buildEvidenceAudit` + `evaluateFinalizationGate`, refuses to
  transition the stage, and explains the real pipeline. `state-machine.ts`
  comments updated to point at the new authority.
- New module `src/finalization/`: `types.ts` (audit/gate/candidate contracts
  + closed blocker/staleness vocabularies), `hash.ts` (fingerprint + audit +
  candidate canonical hashes), `audit.ts` (reachability traversal, per-entry
  rules, audit assembly, load/save consistency guard), `gate.ts` (pure gate),
  `candidate.ts` (deterministic assembly + preview).
- Authority class: both artifacts are `derived_artifact` — creating them
  requires no Proposal, no Approval, no PlanCommit, creates zero Snapshots,
  moves HEAD nowhere, changes no stage (§5/§42), never sets
  `PlanningRun.finalPlan` (§40).

## Evidence Reachability

Exactly the relationships the domain represents (§7): HEAD snapshot → design
anchors (exact Architecture revision `basedOn`, exact approved
SectionRevisions' `decisions` lists, plus the snapshot's own
committed-decision bindings) → exact Decision revisions → their `evidence`
refs. The repository is never scanned; the Observation Ledger is never
treated as Evidence; uncited records are ignored; duplicate citations are
deduplicated per record while preserving every (decision, anchors) path;
every entry records WHY it is reachable (§67: `reachableFrom` with exact
`DecisionRef` + closed anchor shapes). Reachability reasons are audit data,
not fingerprint data.

## Evidence Freshness Rules

Closed per-entry rules (§11; architecture §30 verbatim):

- critical: blocks unless `status=active ∧ freshness=fresh ∧
  confidence≠uncertain` (blockers: `evidence_invalidated`, `evidence_stale`,
  `critical_not_fresh`, `critical_uncertain`);
- supporting (documented conservative interpretation): the existing state
  model has no other revalidation signal, so any reachable supporting record
  in `needs_validation`/`stale`/`invalidated` state blocks
  (`supporting_needs_validation` / `evidence_stale` / `evidence_invalidated`);
- informational (documented interpretation): current state is RECORDED —
  entry fields + `counts.informational`/`counts.stale` — but never flags and
  never blocks by itself;
- all classes: a referenced revision that is not the record's newest flags
  `evidence_revision_mismatch` (§8 fail-closed — the audit reports the exact
  referenced state and never silently rebases design provenance).

## Synthesis-vs-current Evidence State

The audit cross-checks every `FrozenEvidenceState` entry of the CURRENT
SynthesisInput against the record's CURRENT newest revision (§9). Material
difference = the record's newest revision is not what synthesis consumed, a
frozen record left the reachable set, or (defensively) immutable fields
disagree → audit blocker `synthesis_evidence_stale`. The GATE classifies
this as a STALE finalization (never a semantic blocker; §28 separation), and
the audit's `evidenceStateHash` is independently re-checked against a live
recompute on every request (§26 `evidence_audit_stale`). Documented recovery
path (§13): evidence is repaired through the repository/Evidence workflows
(new immutable revision), then a re-freeze at the same HEAD freezes a NEW
SynthesisInput (freeze is hash-idempotent per authoritative state, so
changed evidence ⇒ new input identity), and the new identity requires fresh
manifest → validation → gate. No gate term is weakened to improve UX; the
audit never mutates or refreshes Evidence (§12).

## EvidenceAuditSnapshot Contract

As frozen in `finalization/types.ts` (adapted from the brief's §14 sketch):
`id: AUD-###`, `planID`, `headSnapshot`/`headCommit`,
`synthesisInput {id, hash}`, `synthesisManifest {id, revision, hash}`,
`validationReport {id, hash}`, `entries[]` (exact `ref {id, revision}`,
`latestRevision`, state fields, `derivedFrom?`, `sourceIdentities`,
`reachableFrom`, `verdict`, `blockers[]`), `counts` (freshCritical /
freshSupporting / informational / needsValidation / stale / invalidated /
criticalUncertain), `result: "pass" | "blocked"`, `blockers[]` (closed
8-code vocabulary incl. `evidence_missing`, `evidence_revision_mismatch`,
`synthesis_evidence_stale`), `evidenceStateHash`, `createdAt`, `hash`.
Blocked audits persist deliberately (§46); the save path revalidates full
correspondence with current state under the lock (§48).

## Audit Hash / Idempotency

Canonicalization is the existing derived-artifact contract
(`stableStringify` + SHA-256). Audit hash payload: everything EXCEPT
`id`/`createdAt`/`hash` (§16). `evidenceStateHash` covers per-entry state +
`recordRevision` (so a NEW revision of any reachable record moves the
fingerprint even though revisions are immutable — a known source change can
never hide) + `derivedFrom` + represented source-provenance identities;
entries are sorted by (id, revision) before hashing. Audit identity =
`headSnapshot | inputHash | manifestHash | reportHash | evidenceStateHash`;
`request_finalization` over the same state REUSES the same audit (§17) — no
duplicate audits; historical audits remain immutable and loadable even after
evidence advances (durable-load check requires the record to never shrink
below the recorded `latestRevision`, not equality — evidence may legitimately
move afterwards, §9).

## Deterministic Finalization Gate

`evaluateFinalizationGate(deps): FinalizationGateResult` — PURE, synchronous,
value-in/value-out; zero store access, zero model calls (§18). Callers
(controller, tests) resolve authoritative objects first. Terms (§19-§27):
run shape (lifecycle/stage/activeWork), HEAD, exact architecture term (run
ref ↔ snapshot ref ↔ approved record — no latest resolution), every required
Section in canonical DAG order (approved, valid, currentRevision =
approvedRevision = resolved revision, canonical contract stamped with its own
identity), synthesis identity (input non-stale, manifest mirrors input,
`unresolvedFindings == 0`), ONE CURRENT clean ValidationReport (binding
re-verified inside the gate), the current passing EvidenceAuditSnapshot, and
LIVE blocking questions/conflicts from CURRENT run state (§24/§25 — the
frozen SynthesisInput copies are never consulted for this term). No
force/skip/ignore flags exist anywhere in the surface (§27).

## Gate Blocker / Staleness Semantics

Closed vocabularies (§28), never conflated; STALE takes precedence:

- blockers (`blocked`): `lifecycle_not_active`, `stage_not_synthesis`,
  `active_work_present`, `head_missing`, `sections_missing`,
  `architecture_missing`, `architecture_not_approved`,
  `architecture_snapshot_mismatch`, `section_not_approved`,
  `section_needs_review`, `section_revision_mismatch`,
  `section_contract_missing`, `synthesis_input_missing`,
  `synthesis_manifest_missing`, `manifest_input_mismatch`,
  `manifest_unresolved_findings`, `validation_not_clean`,
  `evidence_audit_missing`, `evidence_audit_blocked` (embedding the audit's
  evidence blockers), `blocking_question`, `blocking_conflict` (with exact
  ids);
- staleness (`stale`): `synthesis_input_stale`, `manifest_not_current`,
  `validation_report_not_current`, `evidence_audit_stale`,
  `synthesis_evidence_stale` (+ `head_changed` reserved for store-level race
  reporting). A PASS returns the exact `FinalizationIdentity`
  (HEAD + input + manifest + report + audit refs/hashes), which the
  candidate binds (§29: never a persisted boolean).

## Live Question / Conflict Checks

Blocking terms are read from the run's CURRENT `openQuestions`/`conflicts`
on every gate evaluation, every status resolution, and (defensively) inside
the candidate save's in-lock revalidation — a stale clean ValidationReport is
never permission to ignore a newly raised blocker (§25/§50/§69).

## Semantic Validation Binding

The gate accepts only a report whose `inputHash` == current input hash,
`manifestHash` == current manifest hash, `baseSnapshot` == current HEAD, and
`result == "clean"`; anything else is either a blocker
(`validation_not_clean`) or staleness (`validation_report_not_current`). A
clean report for a historical manifest/input never counts (§21; §66 cases
9/10).

## FinalPlanCandidate Contract

As frozen in `finalization/types.ts` (adapted from the brief's §31 sketch):
`id: FPC-###`, `planID`, store-assigned `revision`, `baseSnapshot`/
`baseCommit`, `architecture`, exact `sections` (canonical DAG order), exact
`decisions`, committed `constraints` (identity-only domain — no invented
revisions), bound `synthesisInput`/`synthesisManifest`/
`semanticValidation`/`evidenceAudit` refs+hashes, EXACT
`implementationOrder`/`limitations` copies, the frozen `validation` summary
(zeros + clean + pass), `createdAt`, `hash`.

## Deterministic Candidate Assembly

`assembleFinalPlanCandidate` is a pure projection of the passing gate
identity + the resolved input/manifest (§32) — no model call, no new
normative prose. Implementation order and limitations are EXACT manifest
copies (§33/§34 — order numbers are the Harness-derived values; a
non-blocking limitation is still copied, §34). Decisions/constraints/
sections bind exact committed refs from the input (never "latest",
§35/§36). The store computes the hash from the draft itself, so no caller
can diverge from hashed content.

## Candidate Hash / Idempotency

Hash payload: everything EXCEPT `id`/`revision`/`createdAt`/`hash` (§37).
Identity = `headSnapshot | inputHash | manifestHash | reportHash | auditHash`
(§38). `saveFinalPlanCandidate` performs the identity lookup FIRST (so
concurrent same-state requests converge on ONE candidate revision, §73),
then full in-lock revalidation (bound audit pass + clean report + exact
input/manifest mirrors + section/decision/constraint/order/limitation
equality + currency + fingerprint + live blockers), then assigns ONE stable
family id with contiguous immutable revisions (§39). Any drift fails
`finalization_stale` with zero partial state (§48).

## Candidate Current / Stale Semantics

Currency is DERIVED, never stored (§51):
`resolveSynthesisFinalization` (exported; used by status, the L0 protocol
hook, and the capability context) recomputes the live evidence fingerprint
and live blockers and reports `Final candidate: current|stale`. A stale
candidate demotes the capability surface back to validation-clean; the
stored candidate is never mutated. Status renders the §57 state machine —
`Finalization: unavailable` (before a current clean report) / `not run` (+ a
current-identity audit line; a PASS audit without a candidate is the
interrupted-freeze crash window and stays honest "not run") / `blocked` (+
`Evidence audit: AUD-### <result>` + `Blockers: <codes>`) / `passed` (+
`Evidence audit: AUD-### pass`, `Final candidate: FPC-###@n`, `Stage:
synthesis`, `Final approval: not requested`). "Final approved" and "Ready
for Build" are never rendered.

## Capability Matrix

`request_finalization` added (v0.9 §3/§4, footnote ⁹): granted ONLY in
`synthesis/validation-clean` (request deterministic finalization) and
`synthesis/final-candidate-ready` (idempotent retrieval/recheck). The
candidate-ready surface is the MINIMAL §54 set: reads + harmless blocker
tools + `request_finalization` — no `prepare_proposal`, no Section mutation,
no Final approval, no handoff, no `request_synthesis` (still withheld
everywhere, §55; its footnote updated). Matrix is six synthesis substates,
pinned by `test/capabilities.test.ts`.

## Plan Memory Reads

`plan_memory` extends to `kind=evidence_audit` (EXACT id; unknown ids are
errors, never resolved to current) and `kind=final_plan_candidate` (by id =
newest revision; with `revision` = EXACT historical read, never resolved to
latest/current) (§56). Both ride the dedicated derived-artifact result-ref
shapes (not the committed-memory MemoryRef union); `buildMemoryRef` rejects
them as memory targets.

## Durable Representation

Additive document families `evidenceAudits` / `finalPlanCandidates`
(keyed `AUD-###` / `FPC-###@REV`) ⇒ `STORE_SCHEMA_VERSION` stays 1 (§61:
absence unambiguously means "finalization never ran"; no existing family
reinterpreted; reasoning documented in `document.ts`). Store boundary adds
only narrow immutable operations (§59/§60): `saveEvidenceAudit`,
`getEvidenceAudit`, `getCurrentEvidenceAudit`, `listEvidenceAudits`,
`findEvidenceAuditByIdentity`; `saveFinalPlanCandidate`, `getFinalPlanCandidate`,
`getCurrentFinalPlanCandidate`, `listFinalPlanCandidates`,
`findFinalPlanCandidateByIdentity`. No update/replace API exists. Both saves
run under the durable write lock with in-lock rehydration. Events:
`finalization.audit_saved` and `finalization.candidate_saved` (one per
actually-persisted artifact; idempotent replays emit nothing).

## Restart Recovery

Fail-closed load validation (no repair, §62/§63): stored hashes must
recompute exactly (audit and candidate); HEAD/base refs must resolve;
input/manifest/report must exist and mirror hashes; entries must resolve at
their exact revision with matching immutable state and a latest revision the
family never shrinks below (historical audits stay loadable after evidence
advances — §9); counts/result/blockers/verdicts must agree and the closed
vocabulary must hold; `evidenceStateHash` must recompute from the entries'
fingerprint inputs; the candidate must be the EXACT projection of its bound
authority objects (snapshot/commit, architecture, sections, decisions,
constraints, implementationOrder == manifest's, limitations == manifest's,
validation summary exact). Save-time goes further: full traversal recompute
of the reachable fingerprint and live-blocker checks under the lock (§48).
The full restart matrix (validation-clean / blocked audit / passing audit /
current candidate / historical stale candidate) survives close/reopen with
byte-identical documents (§71/§74), including compaction independence: a
fresh controller with NO conversation history recovers the entire
finalization state from durable records alone.

## Crash / Concurrency Validation

Real child-process probes (`scripts/crash-probe.mjs`, new `finalization`
mode, §72): before-persist dies on the AUDIT publication → zero audits,
zero candidates, zero HEAD movement, zero PlanCommits; a retry through a
fresh controller completes the vertical. after-persist dies after the
CANDIDATE publication, before the response → reopen sees EXACTLY one audit +
one candidate; a retry is idempotent (`created=false`, same ids/hashes);
stage stays synthesis; `finalPlan` unset. Cross-instance (§73): two
DurablePlanStore instances requesting finalization over the same state
converge on one audit identity + one candidate identity/revision (in-lock
identity lookup before assignment); different current evidence state is NOT
collapsed into the same audit (new fingerprint ⇒ AUD-002 ⇒ gate stale).

## Corruption / Fail-closed Tests

Tampered audit hash; audit referencing missing HEAD snapshot / wrong input /
manifest / report hash mirrors; unknown evidence ref in entries; wrong
`evidenceStateHash`; count mismatch; `pass` with a blocking entry; `blocked`
with inconsistent blockers (§65). Tampered candidate hash; missing audit;
blocked audit referenced by a candidate; wrong manifest / validation report /
synthesis input hashes; section-set mismatch; implementation-order mismatch;
inconsistent validation summary (§64). All fail closed at store open with
`store_corrupt` (never repaired, never downgraded); store-level save refuses
a candidate binding a missing/blocked audit with no partial state.

## Tests Added

`test/finalization.test.ts` — 43 tests:

- pure gate matrix: §66 cases 1-26 (lifecycle, stage, activeWork, missing
  HEAD, stale input, wrong manifest, unresolved findings, missing/findings/
  historical reports, architecture missing/not-approved/snapshot-mismatch,
  section not-approved/needs_review/revision/contract, live blocking
  question/conflict with exact ids, critical
  needs_validation/stale/invalidated/uncertain, supporting
  needs_validation/stale/invalidated, informational stale reported but
  non-blocking, synthesis-evidence drift as STALE), stale-over-blocker
  precedence, audit-identity staleness (§26), missing audit;
- audit construction + reachability (§6-§9/§67/§68): reachable audited /
  unreachable ignored / duplicate reachability deduplicated with reasons /
  exact revisions retained / downstream section revisions as anchors /
  informational-stale recorded non-blocking / pinned-reference exactness
  (`evidence_revision_mismatch`) / unreachable evidence never moves the
  fingerprint / §68 race (evidence changes after audit ⇒ candidate persist
  `finalization_stale`, HEAD never moved) / §9 end-to-end drift ⇒ stale with
  `synthesis_evidence_stale`, old candidate untouched;
- passing vertical (§66 27-32 + §33-§37/§42/§45/§75/§76): exact audit +
  candidate content + hash recompute, zero commits beyond the design chain,
  HEAD unchanged, stage synthesis, `finalPlan` unset, not-a-Proposal
  (no approval path; no authorization fields), deterministic §43 preview;
- idempotency + drift (§17/§38/§46/§49/§50/§69/§70): same request ⇒ same
  AUD/FPC ids+hashes; live question after audit ⇒ `finalization_stale`; live
  blocker before request ⇒ blocked with the audit persisted; changed
  manifest identity ⇒ capability demotion + new gate + historical candidate
  (FPC-001@2 after re-validation); blocked finalization creates nothing;
- reads/status/L0 (§51/§56/§57/§58): exact reads, no silent resolution;
  unavailable → not run → blocked → passed; never "Final approved"/"Ready
  for Build"; derived candidate currency never mutating the stored record;
  §58 verbatim fragments (clean/blocked/candidate-ready);
- durable (§61-§65/§71/§73/§74): restart matrix with byte-identical
  documents; blocked audit survives with exact blockers; 19 corruption
  cases (10 audit + 9 candidate) failing closed at open; store-level
  missing-audit refusal; two-instance convergence; different evidence state
  ⇒ new audit identity, never collapsed.

`test/durable-crash.test.ts` — +2 process-level §72 probes (before/after
persist) with exact control output pins.

Updated: `capabilities.test.ts` (six synthesis substates incl.
candidate-ready), `validation.test.ts` + `section-completion.test.ts` (§58
fragment pins; "finalization not implemented" placeholder removed),
`architecture-workflow.test.ts` (legacy `checkFinalization` use replaced by
the capability refusal — architecture completion is still NOT finalization),
`test/helpers.ts` (legacy helper removed).

## Live OpenCode Validation

Smoke extended to 33 checks (`scripts/opencode-live-smoke.mjs` step 16,
§78): `ultraplan_request_finalization` is registered in the REAL runtime
(tool id list) and refuses outside synthesis/current-clean-validation with a
structured `capability_not_available` (real session, real model invocation,
run in architecture). HONEST SPLIT, stated exactly: the full finalization
vertical (Evidence Audit → gate → FinalPlanCandidate) requires traversing
the interactive Detail/Synthesis approval boundaries that headless smoke
cannot satisfy; it is NOT faked live — it is deterministic
integration-tested (`test/finalization.test.ts`) with process-level crash
probes. Result: **33/33 checks passed, exit 0.**

## Verification Results

Scoped (`-w @switchboard/opencode`, true producer exit codes):

- `npm run typecheck` → **0**
- `npm run lint` → **0**
- `npm test` → **0** (452/452 tests, 18 files; includes the 27
  process-level crash-probe tests)
- `npm run build` → **0**
- `npm run smoke:opencode` → **0** (33/33)

Root aggregate — FIRST attempt (recorded per §77):

- `npm run typecheck` → **2**, `npm run lint` → **1**, `npm test` → **1**,
  `npm run build` → **0**
- ALL typecheck/lint/test failures are inside `adapters/claude-code` — the
  concurrent external workstream, which was LEFT UNTOUCHED (its working tree
  carries 11 files modified by that workstream during this session; zero of
  them are mine). The opencode workspace is green inside the same root run
  (452/452). These failures are deterministic in-flight work (their
  `context-core`/`context-helpers` type errors, a lint unused-var, and 9
  failing tests across 5 of their files) — NOT the Phase 2G timing flake.
- Root retry (classification run): identical claude-code failures
  (9 failed / 441 passed / 1 skipped across the monorepo; packages 40/40;
  opencode 452/452) — persistent, not a flake; reported and left alone per
  the standing constraint.
- `npm run build` (root) → **0**.
- Frozen spec check: `docs/opencode/spec/opencode-ultra-plan-architecture.md`
  unmodified.

## Deviations From Frozen Architecture

No architecture amendment candidates. Documented interpretations (all
brief-mandated "adapt to the real domain" decisions):

- a) Candidate revision model (§39): ONE stable family per plan
  (`FPC-001@n`), mirroring the SynthesisManifest design; id/revision are
  store-assigned in-lock after the identity lookup so cross-instance
  requests converge instead of racing to duplicate a revision.
- b) The audit's per-entry `latestRevision` is fingerprint material: a newer
  revision of any reachable record moves the audit identity even though the
  referenced revision's own fields are immutable — required so a known
  source change can never hide behind pinned references (§10 "at minimum").
- c) Supporting-evidence strictness follows the brief's conservative clause
  (active+fresh required when reachable); the domain has no independent
  "source changed" flag, so revision advancement plays that role (§8/§9
  interplay documented above).
- d) The durable-load evidence check verifies monotonic non-shrinkage
  (`family latest ≥ recorded latestRevision`), not equality — equality would
  reject every HISTORICAL audit after legitimate evidence progress and
  contradict §9.

## Risks / Open Issues

- Evidence-blocker repair from synthesis is indirect by design: a
  `synthesis_evidence_stale`/evidence-blocker recovery requires a re-freeze
  of the SynthesisInput (same HEAD, new evidence states → new identity) and
  a fresh manifest + validation. The loop exists today (hash-idempotent
  freeze), but no dedicated guidance fragment walks the model through
  evidence-repair mid-synthesis; the L0 fragments stay at the §58 brief
  wording.
- `request_finalization` triggers a full reachability traversal +
  fingerprint recompute per request (audit save/gate), and status/capability
  resolution recomputes the fingerprint per synthesis tool call — all
  in-memory map walks over small domains today; fine at current scale, worth
  caching if plans grow large.
- Phase 2I must rerun the gate immediately before the formal Final Proposal
  (the candidate's currency is derived; the gate is the only authority) and
  is the phase that finally exercises the synthesis → final edge and
  `PlanningRun.finalPlan`.

## Phase 2I Entry Conditions

- A CURRENT `FinalPlanCandidate` (or a rerunnable gate that produces one)
  with: exact HEAD anchor, current synthesis identity, current clean
  ValidationReport (`semantic-validation:v1`), current passing
  EvidenceAuditSnapshot, zero live blocking questions/conflicts, every
  required Section approved+valid at agreeing exact revisions.
- Durable state survives restart/crash/concurrency (proven above); the
  candidate's currency is derivable from durable state alone (§74).
- `request_synthesis` still withheld; no Final Proposal, no Final approval,
  no Final PlanCommit, no `handoff_pending` exists yet — candidate ≠ Final
  Plan ≠ authorization.
