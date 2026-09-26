# Phase 13 implementation note — deterministic FinalizationGate & Final Plan authorization

Baseline: Phase 12 freeze (`eba77f4` feat, `888e8f2` test) on Phase 11
(`8847904`, `0b5ea0b`). Phase 13 adds the deterministic finalization layer and
STOPS there: Plan Mode stays on, the PlanningRun stays `active` at stage
`final`, and no handoff/build/exit surface exists (Phase 14 owns the boundary).

## Schema v10 (`010-finalization-final-plan`)

Six immutable tables (all under `no_update`/`no_delete` triggers):

- `evidence_audit_snapshots` — `evaud_…`, `purpose ∈ {pre_approval, commit_time}`,
  binds `input_id`/`input_hash`, optional `candidate_id` (commit-time only),
  UNIQUE(run_id, request_id) for the `finalize:<toolUseId>` idempotency (§72).
- `evidence_audit_entries` — one row per exact audited Evidence revision,
  FK to `evidence_audit_snapshots` AND to `evidence_revisions(run_id,
  evidence_id, revision)` — an audit entry can never point outside the run
  (§91). Stores confidence/criticality/strategy/state/disposition/reason plus
  `last_validation_event_seq` (provenance aid, never design authority, §8).
- `final_plan_candidates` — `fpc_…`, per-run `candidate_seq` 1,2,…, exact
  synthesis chain ids+hashes, canonical JSON, `candidate_hash`, UNIQUE(run_id,
  request_id) (§72), UNIQUE(run_id, candidate_seq) (§30).
- `final_plan_candidate_refs` — exact ref families (`architecture | section |
  decision | constraint | evidence`) for the §91 membership check; the manifest-
  derived `implementationOrder`/`limitations` live only in the canonical JSON
  and are validated against the manifest hash at gate time.
- `proposal_final_plan_refs` — final Proposal ↔ Candidate binding with the
  exact `candidate_hash` (§37).
- `final_plans` — `fplan_…`, revision 1, UNIQUE(run_id) (one approved FinalPlan
  per run in v0.1, §52), full provenance columns: candidate, proposal,
  approval, commit, snapshot, commit-time audit, canonical JSON, hash.

Not created (§5): `execution_handoffs`, `execution_bindings`,
`execution_issues`, `build_sessions`, `handoff_events`. PlanningRun lifecycle
is untouched; handoff authorization is a derived read projection (§58/§59).
NO backfill: a legacy schema-9 run somehow at `final` receives no fabricated
candidate and fails closed on approval with `FINAL_PLAN_CANDIDATE_REQUIRED`
(§77); `request_reopen` recovers it into the design workflow.

`validateSchemaV10` (§91) re-derives in data: audit entries point at exact
same-run Evidence revisions; candidate base HEAD/commit pairs are real
commit-chain pairs; the synthesis chain (input→manifest→report, clean) is
exact; candidate refs ⊆ frozen synthesis world; proposal binding carries the
candidate's exact hash; FinalPlan↔candidate/proposal(approved)/approval/commit/
snapshot all correspond and the Final PlanCommit's resulting snapshot is the
FinalPlan's; Final PlanCommit references the final proposal revision exactly.
Store-open NEVER re-runs the FinalizationGate (§91).

`SUPPORTED_SCHEMA_VERSION = 10`; old writers are fenced `STORE_SCHEMA_TOO_NEW`.

## FinalizationFacts / FinalizationDecision / reason vocabulary (§12–§14)

`core/finalization.ts` is PURE: `evaluateFinalization(facts)` returns
`{status:"pass"} | {status:"deny", reasons:[{code, detail?}]}` — no boolean, no
natural-language reasons. The frozen code vocabulary (§14 + the one audited
addition): `HEAD_STALE, SYNTHESIS_INPUT_MISSING, SYNTHESIS_INPUT_STALE,
SYNTHESIS_MANIFEST_MISSING, SYNTHESIS_MANIFEST_INVALID,
SEMANTIC_VALIDATION_MISSING, SEMANTIC_VALIDATION_NOT_CLEAN,
ARCHITECTURE_MISSING, SECTION_INCOMPLETE, SECTION_NEEDS_REVIEW,
ACTIVE_SECTION_PRESENT, BLOCKING_QUESTION, BLOCKING_CONFLICT,
SYNTHESIS_FINDINGS_UNRESOLVED, EVIDENCE_CRITICAL_NOT_FRESH,
EVIDENCE_SUPPORTING_NEEDS_VALIDATION, AWAITING_PROPOSAL_EXISTS,
EVIDENCE_AUDIT_FAILED`. External MCP errors are uniformly `FINALIZATION_DENIED`
carrying `reasons[]` in `detail`.

`FinalizationFacts` carries: run identity, HEAD pair, the exact synthesis chain
(input/manifest/report ids+hashes, isClean, unresolvedFindingCount), current
HEAD architecture + the input-pinned architecture, HEAD sections joined to
workflow states, the durable active Section, typed blocking question/conflict
counts re-read from HEAD, post-audit Evidence states with a
`requiresReobservation` flag, `evidenceScopeMatches` (recomputed
committed-design reachability == frozen scope, §7), and any other awaiting
proposal (§14). Stage identity is a caller fence (`validation` for the first
request, `final` for the rerun), consistent with every other stage gate.

## Preflight vs pure Core Gate (§25)

`request_finalization` fence order: idempotency replay (`finalize:<toolUseId>`)
→ run/workspace → writable binding → lifecycle → validator denial
(`VALIDATOR_MUTATION_FORBIDDEN`) → **§73 loser check** (a candidate already
frozen for the current input answers `FINALIZATION_ALREADY_PREPARED` BEFORE the
stage gate, so a concurrent loser sees the prepared identity, not the winner's
stage — same precedence lesson as Phase 12 §86) → stage gate (`validation`) →
facts + pure gate → the §29 transaction.

The authorization path reuses the Phase 6 `commitAuthorizedProposal` ordering
verbatim (§47): idempotency → run → workspace → binding → lifecycle → run
revision → proposal identity/state/hash → HEAD/base — and only then enters the
commit-time rerun (below). The ordinary Phase 10 post-authorization Evidence
gate (step 12.5) is skipped for `final_plan`: the full finalization rerun
subsumes it.

## Evidence audit scope and policy (§6–§11)

The audit scope is `current SynthesisInput.relevantEvidence` — never "all
Evidence in the run", never keyword scans, never conversation refs (§7). The
service re-verifies `listRelevantEvidenceInTx` (exported from the synthesis
service) over the current HEAD equals that frozen set; a mismatch denies with
`EVIDENCE_AUDIT_FAILED` (§7/§35).

Policy at audit time (§9), enforced after deterministic revalidation:

- **critical** — must be fresh, with gate-time fingerprint re-hash / coarse
  repository-revision check, recursively over the provenance closure (§40);
- **supporting** — same revalidation; `needs_validation | stale | invalidated`
  blocks (`EVIDENCE_SUPPORTING_NEEDS_VALIDATION`);
- **informational** — recorded only (`disposition=recorded`), never blocks
  (§9/§36);
- **reobserve** — commands are NEVER replayed (§10): a drift on the recorded
  repository revision sets `requiresReobservation` and blocks; the only legal
  cure is `request_reopen` → observation → revalidation → new synthesis cycle.

§11/§49: discovered source changes are appended in-transaction as real
`SOURCE_CHANGED` events with derived propagation and the Phase 11 Section
review bridge, persisting even when the gate (and the whole authorization)
rolls back. The denied commit path re-runs ONLY the audit in a fresh
transaction (`persistDiscoveredEvidenceFacts`) — the same §37 pattern Phase 10
uses — so system facts survive without leaving any partial final result.
§70: a fingerprint revision whose `needs_validation` came from its OWN source
check (last event = SOURCE_CHANGED with a check reason) returns to fresh at
gate time when the exact original content is restored
(`FINGERPRINT_VALIDATED / finalization_gate_content_restored`) — terminal
states and upstream-replacement cases never revive. §71: the candidate stays
bound to the old exact revision; replacement requires the full reopen cycle.

## Pre-approval vs commit-time audit (§2/§3/§33/§34)

The gate runs TWICE and the second run never trusts the first. Nothing is
cached as commit authority — not `finalization_passed`, not freshness, nothing.
The pre-approval snapshot (`purpose=pre_approval`) is the review artifact shown
to the user; the commit-time snapshot (`purpose=commit_time`, bound to the
candidate id) is regenerated inside the authorization transaction and is what
the FinalPlan references (§34). The commit-time exact revision set must equal
the candidate's frozen scope (§35). The rerun sits AFTER all Phase 6 fences
and BEFORE any Approval/PlanCommit/FinalPlan write (§48/E38); any deny throws
`FINALIZATION_DENIED` and the whole authorization rolls back (§68/§100).

## FinalPlanCandidateV1 (§30–§33)

Entirely server-derived: baseRunRevision (the post-bump revision the final
proposal is fenced against), base HEAD pair, exact synthesis chain refs,
architecture/sections/decisions/constraints from the frozen input refs,
`implementationOrder`/`limitations` copied exactly (authored order) from the
accepted manifest, and `evidenceScope` = the frozen relevantEvidence set. The
canonical hash excludes the candidate id/timestamps, so a semantically equal
re-derivation hashes identically (§32). Candidates are permanent history —
a new cycle after reopen freezes a NEW candidate with a new seq (§68/§71).
`renderFinalPlanCandidateMarkdown()` is a deterministic PROJECTION for user
review — never persisted as truth, never hashed as authority, never parsed
back (§44/§80; tested by the projection-marker assertion).

## ProposalCanonicalV3 (§37–§40)

`final_plan` proposals use V3 exclusively: the V2 shape plus
`finalPlanCandidate: {candidateId, candidateHash}` — the proposal hash binds
the exact frozen candidate. `requiredEvidence` is server-set to
`candidate.evidenceScope` (§39); `changes = []` (§40); the model can never
`prepare_proposal(final_plan)` (schema enum excludes it AND the service throws
`PROPOSAL_TYPE_UNAVAILABLE` — defense in depth, §38/§97). V1/V2 canonicals are
untouched: golden parse/hash behavior unchanged (§78), enforced by the existing
hash tests plus the new V3 parse tests.

## request_finalization (§26–§29)

14th MCP tool, main-agent-only, **zero business fields** (§27 — the schema
admits only `_hostContext`, so no bypass flag exists to reject). No
`requiresUserInteraction`: it is a deterministic gate request, not the human
authorization (§28) — the REAL interaction stays with `approve_proposal` on the
exact final Proposal (§46). On pass, ONE transaction freezes: pre-approval
audit + candidate + final proposal + the FIRST production `VALIDATION_CLEAN`
(validation→final) + run revision +1 exactly once (§29/§41/§84). HEAD never
moves (§85). Failure at any step rolls the whole thing back — `stage=final`
without candidate/proposal is structurally impossible.

## get_context(detail=final) / get_state (§43/§61)

`detail=final` (stage final only) returns the candidate (all fields + hash),
the newest Evidence audit summary, the exact final Proposal (awaiting or
approved), the approved FinalPlan identity, and the rendered Markdown
projection. `get_state` at stage final adds `finalPlan {id, revision, hash,
approved:true}` (when present) and the derived `handoff {authorized,
delivered:false}` projection — no Handoff table exists (§59).

## Formal Final Approval path (§46–§52/§67/§75)

The ONLY approval surface remains `approve_proposal(proposal_id,
proposal_revision, proposal_hash)` with `requiresUserInteraction=true`; no
`approve_final_plan` was added. At stage final the capability matrix keeps
`approve_proposal` available (the engine's type gates make the awaiting final
proposal the only approvable one) and shut off everything else (§42/§88).
On success ONE transaction writes: Approval → zero-design-change PlanCommit
(new snapshot id, SAME Plan Memory members as the candidate base HEAD — §50/§51)
→ HEAD advance → proposal approved → immutable FinalPlan (§52–§56) →
`PLAN_COMMITTED` audit payload extended with `finalPlanId/finalPlanHash/
candidateId` (§79, no second event authority). Run revision is NOT bumped
(§52/§84); stage stays `final`; lifecycle stays `active` (§58). Deny/cancel
leaves the proposal awaiting (Phase 7 semantics, §68). Replays are answered by
the Phase 6 idempotency seam (§74/E67). Approve-vs-reopen race: reopen
supersedes + bumps the revision, so the approval fails closed
(`STALE_RUN_REVISION` per Phase 6 §41 precedence, or `PROPOSAL_SUPERSEDED`);
if approval wins, `request_reopen` answers `FINAL_PLAN_ALREADY_APPROVED` (§75).

## FinalPlanV1 (§54/§57)

Canonical payload per §54 (candidateHash, design refs, manifest ref,
implementation order, limitations, the literal validation block
`{blockingQuestions:0, blockingConflicts:0, invalidSections:0,
semanticValidation:"clean"}`, and the COMMIT-TIME audit ref) → SHA-256. The DB
row additionally carries the full candidate/proposal/approval/commit/snapshot
provenance (§56) — never just `approved=true`. Immutable by trigger (§55).
The hash is what Phase 14's ExecutionHandoff must bind (§57) — nobody
re-summarizes the final plan downstream.

## final-stage request_reopen (§65–§67)

Allowed from `final` ONLY while no approved FinalPlan exists; atomically
supersedes the awaiting final Proposal, preserves candidate/audit history
(immutable), moves final→detail/architecture via the frozen state-machine
events, marks completed Sections needs_review (conservative full review;
`finding_ids` stay validation-only), bumps the revision exactly once, and
never moves HEAD (§66/§84/§85). After FinalPlan approval the boundary belongs
to Phase 14 (§67).

## Context v4 / epoch v4 (§62–§64)

`PhasePlanContext` version 4, epoch `context-epoch:v4`. The context gains the
`finalization` world (candidate id/seq/hash, newest audit, exact final
Proposal with status, approved FinalPlan, derived `handoffAuthorized`); the
epoch inputs gain the candidate id/hash, final Proposal id/revision/hash, and
FinalPlan id/hash (§63) — raw Evidence validation event seqs never enter, and
the Final PlanCommit moves the epoch through HEAD itself. Recovery capsule
(v4 header) gains the finalization segment: awaiting → "Finalization passed. /
Final Plan Candidate: … / Final Proposal: awaiting approval"; approved →
"Final Plan approved: … / Handoff authorized. / Execution handoff has not yet
been delivered." (§64). It never says "planning completed" or "build started".
`CONTEXT_DETAILS` gains `"final"`.

## Why handoff is explicitly Phase 14 (§59/§60/§108)

`handoff_pending` in the architecture is a recoverable transition condition,
not a design stage: v0.1 represents it deterministically as `active run +
stage=final + approved FinalPlan + handoff not recorded`. Phase 13 ships no
ExecutionHandoff/ExecutionBinding structures, no handoff tool, no lifecycle
`completed` transition, and ExitPlanMode remains hook-denied even after Final
Approval (verified live: the PreToolUse hook returns the frozen
"Phase Plan has not completed Final Approval/Handoff…" denial on an
approved-FinalPlan run).

## Error vocabulary (§90)

New domain codes (exit 6): `FINALIZATION_DENIED`,
`FINALIZATION_ALREADY_PREPARED`, `FINAL_PLAN_CANDIDATE_REQUIRED`,
`FINAL_PLAN_CANDIDATE_STALE`, `FINAL_PLAN_ALREADY_APPROVED`,
`FINAL_PLAN_PROPOSAL_INVALID`, `EVIDENCE_AUDIT_FAILED`. Reused per §90:
`EVIDENCE_NEEDS_VALIDATION`, `BLOCKING_QUESTION/CONFLICT`,
`STALE_SESSION_BINDING`, `STALE_RUN_REVISION`, `PROPOSAL_HASH_MISMATCH`,
`PROPOSAL_SUPERSEDED`, `IDEMPOTENCY_CONFLICT`.
