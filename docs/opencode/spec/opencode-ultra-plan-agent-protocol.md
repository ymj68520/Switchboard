# Ultra Plan Agent Protocol — v0.11 (Phase 2A + 2A.1 + 2B1 + 2C + 2D + 2E1 + 2E2 + 2F + 2G + 2H + 2I + 2J)

**Status:** Frozen v0.1 contract as corrected by the Phase 2A.1
authority-boundary freeze, extended by the Phase 2B1 transaction engine
(approval-request presentation capability + approval/commit semantics), by the
Phase 2C Discovery → Architecture planning workflow (`add_architecture` /
`add_constraint`, `ultraplan_request_architecture`, architecture-scoped
completion, atomic architecture → detail stage transition, constraint
authority), by the Phase 2D Detail decomposition workflow
(`ultraplan_prepare_section_decomposition`, draft-local keys → authoritative
SEC ids, `add_section` / `select_initial_section` change kinds, initial-focus
admission, Section-root snapshots, state-dependent detail capabilities), and by
the Phase 2E1 Section checkpoint workflow
(`ultraplan_prepare_section_checkpoint`, `add_section_revision` change kind,
Section-root status semantics, Harness-bound dependency contract revisions,
deterministic `needs_review`/`valid` validation, stable projections, temporary
Section-completion deferral), and by the Phase 2E2 Section completion & work
progression workflow (`request_completion` kind="section" restored, exact
revision completion targets, dependency-completion + validation gates,
`ultraplan_request_section_focus`, deterministic next-work selection,
atomic detail → synthesis entry, temporary Synthesis capability narrowing),
and by the Phase 2F Frozen Synthesis Input & Provenance-bound Synthesis
Manifest workflow (the `derived_artifact` authority class,
`ultraplan_begin_synthesis` freezing the HEAD-anchored `SynthesisInput`,
`ultraplan_submit_synthesis_manifest` creating immutable provenance-bound
`SynthesisManifest` revisions with structural-only validation — no Approval,
no PlanCommit, no HEAD movement, no stage transition), and by the Phase 2G
Read-only Semantic Validation & Section Reopen Admission workflow (the
isolated `SemanticValidator` runtime boundary and the frozen
`semantic-validation:v1` protocol, `ultraplan_run_semantic_validation` with NO
authoritative report content from the model, strict-JSON validator output
parsing, immutable canonical-hashed `ValidationReport` artifacts, the
anti-laundering rule (one exact input+manifest+protocol identity yields
exactly ONE successful report), five synthesis capability substates
(unvalidated / findings / clean), the narrow restoration of
`ultraplan_request_reopen` for semantic-validation findings (synthesis) and
dependency review (detail), and the closed `reopen_section` PlanCommit change
— the only sanctioned path from synthesis back to design; `request_synthesis`
remains withheld and a clean report does NOT grant finalization), and by the
Phase 2H Evidence Audit, Deterministic Finalization Gate & Final Plan
Candidate workflow (the `EvidenceAuditSnapshot` derived artifact built over
exactly the Evidence structurally reachable from the CURRENT approved design,
the pure `evaluateFinalizationGate` — the ONE finalization authority, successor
of the Phase 1 `checkFinalization` placeholder — with separate BLOCKED and
STALE result buckets, `ultraplan_request_finalization` accepting NOTHING from
the model, and the immutable deterministic `FinalPlanCandidate` — assembled
from approved Plan Memory + the validated manifest + the clean report + the
passing audit with NO model call, never `PlanningRun.finalPlan`, never user
authorization, never a stage transition: after a PASS the stage REMAINS
synthesis; evidence can invalidate finalization without HEAD moving; a sixth
synthesis substate `final-candidate-ready` carries the minimal recheck
surface; `request_synthesis` remains withheld), and by the Phase 2I Formal
Final Proposal, Final Approval & Final PlanCommit workflow (the
`ultraplan_prepare_final_plan` operation — proposal_intent, accepts NOTHING
from the model — which reruns the deterministic Finalization Gate and freezes
the exact `final_plan` Proposal carrying exactly one `add_final_plan` change,
the complete FinalPlan payload projected by the shared
`buildFinalPlanFromCandidate` from the CURRENT FinalPlanCandidate with the
Harness-assigned FINAL-###@n identity; a SEVENTH synthesis substate
`final-proposal-ready` narrowly granting `request_user_approval`; the exact
standard Approval protocol binding Proposal id/revision/hash with actor=user;
a MANDATORY SECOND FinalizationGate inside the transaction engine immediately
before the Final PlanCommit with EXACT identity equality — approval of an
exact Proposal never authorizes subsequently changed state; the single atomic
Final PlanCommit publishing the immutable approved FinalPlan +
`PlanningRun.finalPlan` + stage synthesis → final + lifecycle active →
handoff_pending in one publication; the run stays synthesis/active while the
user considers the Proposal; handoff_pending is NOT Build — the runtime
handoff, ExecutionHandoff, and `lifecycle = completed` are later work).
The frozen architecture itself is unchanged; this document is the
implementation-layer contract and may evolve per corrective phases.
**Authority:** Derived from `opencode-ultra-plan-architecture.md` (frozen, unmodified) + Phase 2A brief
**Enforcement:** `adapters/opencode/src/core/capabilities.ts` (matrix), `src/tools/contracts.ts` (registry), `UltraPlanController.authorizeTool` (gate) — pinned by tests

This document closes the §38 gap ("Planning Agent Protocol + Tool Contract") of the frozen
architecture. It defines how the planning MODEL interacts with the Harness. The guiding
boundary is non-negotiable:

```text
LLM
 │ proposes / reasons / explores
 ▼
Harness Tools
 │ validate capability + state
 ▼
Controller / (Phase 2B) Transaction Engine
 │ enforce invariants
 ▼
Committed Plan Memory
```

The model is the planning intelligence. The Harness is the workflow authority. Prompt
instructions alone never carry these rules; they are enforced in code and every violation
fails with a deterministic error code.

---

## 1. Agent Responsibilities

The planning agent MAY:

- inspect current planning state (`ultraplan_status`);
- inspect committed Plan Memory within the read boundary (`plan_memory`);
- inspect repository state through OpenCode-native tools (read/grep/bash/...);
- reason about architecture and design in the conversation;
- create working design (discussion only — never committed directly);
- identify and record open questions (`ultraplan_record_question`);
- propose CANDIDATE resolutions for its recorded questions
  (`ultraplan_propose_question_resolution`) — the question stays open and
  keeps blocking (Correction A);
- raise conflicts between design elements (`ultraplan_raise_conflict`);
- promote observations it actually made into Evidence
  (`ultraplan_promote_evidence`);
- REQUEST the discovery → architecture transition when it judges discovery
  sufficient (`ultraplan_request_architecture`, Phase 2C) — the Harness decides;
- prepare proposal candidates (`ultraplan_prepare_proposal`), including the
  exact initial Architecture Proposal (`add_architecture`) and committed
  constraints (`add_constraint`) in the architecture stage;
- propose the project-specific logical decomposition — draft-local section
  definitions, dependency relationships, and the preferred initial focus —
  through ONE atomic operation (`ultraplan_prepare_section_decomposition`,
  Phase 2D). Draft keys are the model's own naming; authoritative `SEC-###`
  identities are Harness-assigned;
- freeze the ACTIVE Section's detailed design into the next exact
  SectionRevision checkpoint — full design, stable compact projection, and
  dependency-facing SectionContract in ONE approval payload
  (`ultraplan_prepare_section_checkpoint`, Phase 2E1). The target is always
  `run.activeWork`; the Harness assigns the resulting revision number and
  resolves every dependency contract binding;
- request artifact completion (`ultraplan_request_completion`, `kind:
  "architecture" | "section"`). Since Phase 2E2, `kind="section"` targets the
  ACTIVE Section's exact current approved checkpoint — the model supplies no
  revision, status, or dependencies, and the Harness returns precise blocker
  errors (`dependency_incomplete`, `section_needs_review`, …) when the
  deterministic gates fail (§7.9);
- REQUEST a workflow focus change to another committed pending/active Section
  (`ultraplan_request_section_focus`, Phase 2E2) — the Harness validates and
  performs the durable transition; discussion order may run ahead of the
  completion order;
- request reopen/amendment of approved design (`ultraplan_request_reopen`);
- request the synthesis → final gate when it believes the plan is complete
  (`ultraplan_request_synthesis`).

## 2. Agent Prohibitions

The planning agent may NOT — and no tool exists that would allow it:

- start planning on its own: creating or resuming a PlanningRun requires an
  explicit `/ultra-plan` command issued by the USER, and the model cannot mint
  an admission (Correction B);
- authoritatively resolve an open question (`open → resolved`); it can only
  record candidate resolutions, and blocking questions stay blocking until a
  PlanCommit containing `resolve_question` applies (Correction A);
- approve its own (or any) Proposal — approval is USER authority;
- commit a Proposal — commit is HARNESS authority (Phase 2B transaction engine);
- mutate committed revisions (approved decisions/sections/architecture are immutable);
- silently overwrite approved design — changes go through reopen/amendment;
- directly advance authoritative state (no stage forcing: since Phase 2C it may
  only REQUEST discovery → architecture via `ultraplan_request_architecture`;
  the architecture → detail transition happens ONLY inside an approved
  `architecture_completion` PlanCommit and no tool can cause it);
- bypass dependency checks (completion requests validate dependency approval);
- bypass evidence freshness gates (finalization validates critical evidence);
- create Evidence without provenance (direct evidence requires real observations);
- choose authoritative Section ids, write Section roots, edit dependency edges,
  or replace `PlanningRun.sections` outside a PlanCommit (Phase 2D): the
  initial decomposition is one Harness-frozen atomic proposal, and both
  `sections` and `activeWork` are commit-gated run fields;
- force `activeWork`: the initial Section focus is part of the frozen
  decomposition Proposal (`select_initial_section`) and is established only by
  its PlanCommit — there is no `set_active_work` tool;
- choose SectionRevision identity or write Section revisions outside a
  PlanCommit (Phase 2E1): the model cannot supply `sectionID`, `revision`,
  `status`, `createdAt`, or the contract's `sectionID`/`revision` — the
  Harness assigns them at freeze; `add_section_revision` is NOT part of the
  generic `ultraplan_prepare_proposal` vocabulary and no loose incremental
  revision-creation tool exists;
- pick the checkpoint target: the checkpoint operation targets
  `run.activeWork` and accepts no authoritative section id (Phase 2E1; the
  engine independently refuses an off-focus checkpoint with
  `checkpoint_scope_invalid`);
- claim contract facts the revision does not state: the contract projection's
  invariants/interfaces/decisions must resolve to facts the revision itself
  contains (validated deterministically at freeze, `invalid_scope`);
- treat a checkpoint as completion: `approvedRevision` means "latest approved
  checkpoint" — a checkpoint approval does NOT complete the Section (Phase 2E1
  §18), and Section completion itself is a separate `section_completion`
  Proposal with its own deterministic gates (Phase 2E2);
- choose a completion target: `request_completion(kind="section")` accepts NO
  authoritative inputs — the Harness binds the exact current approved revision;
  there is no "complete latest" resolution and the engine independently
  re-validates the target (`completion_target_mismatch`);
- move the workflow focus through any path except the sanctioned
  `ultraplan_request_section_focus` request: generic run-header mutation of
  `activeWork` stays commit-gated-forbidden and `set_active_work` still does
  not exist (Phase 2E2 §19);
- introduce new normative design from Synthesis (Phase 2F §3): the model may
  organize, connect, order, and report over approved design, but no
  synthesis-path tool can create a Decision, Constraint, Architecture
  revision, SectionRevision, SectionContract, Proposal, Approval, PlanCommit,
  or FinalPlan — there are no `newDecisions`/`newConstraints`/
  `architectureChanges`/`approvedFacts` fields on the manifest shape and no
  tool that could write them;
- select synthesis authority (Phase 2F §20/§24): `ultraplan_begin_synthesis`
  accepts NO refs at all and `ultraplan_submit_synthesis_manifest` accepts
  ONLY derived content — manifest identity, revision, input binding, base
  Snapshot, Architecture ref, Section set, and hash are Harness-assigned;
- treat a SynthesisManifest as validated design (Phase 2F §34): the manifest
  is STRUCTURALLY valid (provenance/coverage/DAG order) — semantic
  validation (unsupported facts, contradictions, derivations) is the Phase 2G
  validator's authority and has NOT run;
- declare the manifest semantically valid itself (Phase 2G §6): there is NO
  `ultraplan_submit_validation_report` tool and no model-facing mechanism that
  accepts report content — `ultraplan_run_semantic_validation` accepts NO
  arguments; only the Harness invokes the isolated validator, parses its
  strict output, and persists the report;
- re-roll semantic validation (Phase 2G §25 anti-laundering): the same exact
  (SynthesisInput hash + SynthesisManifest hash + validator protocol)
  identity ALWAYS returns its existing successful report — a findings report
  can never be re-validated into a clean one; a new judgment requires a
  genuinely changed design or manifest revision (new identity);
- treat `result = clean` as finalization (Phase 2G §4/§55): a clean report
  proves ONLY the semantic-validation component — blocking questions/
  conflicts, evidence freshness, the Evidence Audit, and the deterministic
  Finalization gate are NOT satisfied by it; the stage remains synthesis and
  `request_synthesis` stays withheld;
- apply a reopen directly (Phase 2G §39): `reopened` is COMMITTED artifact
  state — `ultraplan_request_reopen` only freezes an `amendment` Proposal
  binding the exact target revision and validation-report evidence; the
  user's explicit Approval and the `reopen_section` PlanCommit apply it;
- mutate or resolve a ValidationReport (Phase 2G §51): reports and their
  findings are immutable history — a reopen commit does not mark findings
  "resolved"; the subsequent design change simply makes the old
  input/manifest/report historical for future finalization;
- falsely resolve an Architecture-level finding through a Section reopen
  (Phase 2G §53): a reopen is admitted only when a selected finding affects
  the exact target SectionRevision — architecture-only findings remain
  blocking (`reopen_target_unsupported`), and architecture reopen remains
  unsupported in Phase 2G;
- mutate or rebase a frozen SynthesisInput (Phase 2F §42): no update/refresh/
  add-section operation exists; when authority state changes the old input
  becomes stale/historical and a NEW input is frozen;
- run, pass, or weaken the finalization gate itself (Phase 2H §3/§18/§27):
  `ultraplan_request_finalization` accepts NOTHING — no `force`, no
  `skipEvidence`, no `ignoreQuestions`/`ignoreConflicts`, no `allowPartial`,
  and no manifest/report/head/evidence references; the Harness resolves every
  authoritative object and the pure deterministic gate re-evaluates from
  CURRENT state on EVERY request (never a persisted "finalizationPassed");
- declare the evidence audit passed or the plan final (Phase 2H §4): the
  model may only REQUEST finalization — blocked/stale outcomes return exact
  machine reasons and the model cannot claim the plan is final; the old
  provisional `request_synthesis` shortcut stays withheld (granted nowhere);
- treat a FinalPlanCandidate as the FinalPlan or as user authorization
  (Phase 2H §30/§40/§75): the candidate is a derived workflow artifact — it
  creates no Proposal, no Approval, no PlanCommit, sets no
  `PlanningRun.finalPlan`, moves HEAD nowhere, leaves the stage at synthesis,
  and does NOT authorize Build;
- rebasing an old candidate onto new state (Phase 2H §47): staleness is
  derived, never stored — when HEAD, synthesis identity, validation report,
  or reachable evidence moves, the historical candidate stays immutable and
  a fresh gate must pass again;
- supply Final Plan content or identity (Phase 2I §6/§9):
  `ultraplan_prepare_final_plan` accepts NOTHING — no candidate/manifest/
  report/audit/head references and no plan payload; the Harness reruns the
  Finalization Gate, requires the CURRENT candidate's exact identity, projects
  the FinalPlan through the shared `buildFinalPlanFromCandidate`, and assigns
  FINAL-###@n itself; `add_final_plan` is NOT part of the generic
  `ultraplan_prepare_proposal` vocabulary and a final_plan Proposal carries
  EXACTLY ONE change (no design change can be smuggled into Final approval);
- treat a final_plan Proposal as authorization or as a stage change
  (Phase 2I §3/§24): a frozen (even awaiting) Final Proposal commits nothing,
  moves HEAD nowhere, and leaves the run at stage=synthesis / lifecycle=active
  — only the successful Final PlanCommit performs both transitions, and only
  an exact user Approval (actor=user, bound to proposal id + revision + hash)
  authorizes it;
- re-present a stale Final Proposal for approval (Phase 2I §20/§57): before
  any user-facing confirmation the Harness re-verifies the Proposal's
  candidate binding and the CURRENT gate identity — a Proposal whose candidate
  or identity has moved is refused `final_proposal_stale` pre-ask and can
  never commit, even with an Approval (the engine independently reruns the
  gate and requires exact identity equality at commit);
- authorize or trigger final execution handoff — that requires explicit Final Plan
  approval and is executed by the Harness.

Prohibited tool names that MUST NEVER be registered: `ultraplan_approve`,
`ultraplan_commit`, `ultraplan_force_stage`, `ultraplan_complete_run`,
`ultraplan_plan_exit`, and any generic mutation tool (`write_memory`,
`update_decision`, `save_architecture`, `set_section_status`, `mark_approved`,
`commit_anything`, `set_stage`). The registry enforces this by construction
(`FORBIDDEN_TOOL_NAMES` + tests).

---

## 3. Tool Inventory and Authority Classes

Every model-visible tool has exactly one authority class:

| Authority | Meaning |
|---|---|
| `read` | Never changes any state |
| `working_state` | Mutates run-header working state (questions, conflicts) — never committed memory |
| `proposal_intent` | Creates/validates proposal candidates — frozen, hashed, never auto-committed |
| `repository_evidence` | Promotes observations to Evidence in the separate evidence trust domain |
| `derived_artifact` | Creates IMMUTABLE DERIVED WORKFLOW ARTIFACTS (Phase 2F: SynthesisInput / SynthesisManifest; Phase 2G: ValidationReport; Phase 2H: EvidenceAuditSnapshot / FinalPlanCandidate — durable, content-hashed, exact-ref-bound) — must NEVER mutate committed Plan Memory, requires no Approval/PlanCommit, never moves HEAD |

| Tool | Authority | Capability gate | Requires active run | mutatesCommittedMemory |
|---|---|---|---|---|
| `ultraplan_start` | working_state | `start_or_resume` | no — but REQUIRES a one-shot `/ultra-plan` command admission (Correction B) | false |
| `ultraplan_status` | read | `read_status` | no (reports absence) | false |
| `plan_memory` | read | `read_memory` | no (works on any lifecycle) | false |
| `ultraplan_record_question` | working_state | `record_question` | yes | false |
| `ultraplan_propose_question_resolution` | working_state | `propose_question_resolution` | yes | false |
| `ultraplan_raise_conflict` | working_state | `raise_conflict` | yes | false |
| `ultraplan_promote_evidence` | repository_evidence | `promote_evidence` | yes | false |
| `ultraplan_request_architecture` | working_state | `request_architecture` | yes | false (moves run WORKING stage discovery → architecture; touches no committed memory) |
| `ultraplan_prepare_proposal` | proposal_intent | `prepare_proposal` | yes | false |
| `ultraplan_prepare_section_decomposition` | proposal_intent | `prepare_decomposition` | yes — ONLY in detail/decomposition-needed | false (freezes proposal INTENT; only user approval + PlanCommit create Section memory) |
| `ultraplan_prepare_section_checkpoint` | proposal_intent | `prepare_section_checkpoint` | yes — ONLY in detail/section-ready (both substates) | false (freezes proposal INTENT; commit creates the immutable SectionRevision) |
| `ultraplan_request_section_focus` | working_state | `request_section_focus` | yes — ONLY in detail/section-ready (both substates) | false (Harness-owned workflow-focus transition; no Approval, never committed memory) |
| `ultraplan_request_user_approval` | proposal_intent | `request_user_approval` | yes | false |
| `ultraplan_request_completion` | proposal_intent | `request_completion` | yes | false |
| `ultraplan_request_reopen` | proposal_intent | `request_reopen` | yes — ONLY in detail/section-ready (dependency_review) or synthesis/validation-findings (semantic_validation) | false (freezes the closed `reopen_section` amendment INTENT; only user approval + PlanCommit apply the reopen) |
| `ultraplan_request_synthesis` | proposal_intent | `request_synthesis` | yes | false (WITHHELD — granted nowhere; a clean ValidationReport does NOT gate the synthesis → final transition in Phase 2G) |
| `ultraplan_begin_synthesis` | derived_artifact | `begin_synthesis` | yes — ONLY in a synthesis substate | false (freezes the HEAD-anchored SynthesisInput; never a PlanCommit, never HEAD movement) |
| `ultraplan_submit_synthesis_manifest` | derived_artifact | `submit_synthesis_manifest` | yes — ONLY in synthesis with a current input | false (creates an immutable manifest revision; never a PlanCommit, never HEAD movement) |
| `ultraplan_run_semantic_validation` | derived_artifact | `run_semantic_validation` | yes — ONLY in synthesis with a current input+manifest | false (invokes the ISOLATED validator — the model supplies no report content; persists an immutable ValidationReport; never a PlanCommit, never HEAD movement) |
| `ultraplan_prepare_final_plan` | proposal_intent | `prepare_final_plan` | yes — ONLY in synthesis/final-candidate-ready (or final-proposal-ready for idempotent retrieval) | false (reruns the Finalization Gate and freezes the exact final_plan Proposal from the CURRENT candidate — the model supplies NOTHING; the Proposal is not approval, commits nothing, never moves HEAD, and never changes the stage) |
| `ultraplan_request_finalization` | derived_artifact | `request_finalization` | yes — ONLY in synthesis/validation-clean or synthesis/final-candidate-ready | false (builds/reuses the EvidenceAuditSnapshot and evaluates the pure Finalization Gate; pass freezes an immutable FinalPlanCandidate — no PlanCommit, no HEAD movement, no stage change, never `PlanningRun.finalPlan`, never user authorization; blocked/stale return exact machine reasons and persist only the audit) |

`allowedStages`/`allowedLifecycle` in code are DERIVED from `getCapabilities`, so the
registry cannot drift from enforcement. The matrix below is the human-readable form of
the same truth and is pinned by `test/capabilities.test.ts`.

---

## 4. State → Capability Matrix (v0.11)

Stage and lifecycle are separate axes and are never collapsed. Since Phase 2D,
the DETAIL column is resolved into STRUCTURED SUBSTATES derived from run state
— not a new persisted stage. Since Phase 2E1 there are THREE:
`detail/decomposition-needed` (sections empty), `detail/section-ready,
revisionless active section` (DAG committed, the focused root has no approved
SectionRevision), and `detail/section-ready, checkpointed active section` (the
focused root has an approved checkpoint). `getCapabilities(run, context)`
resolves the substate from the store-resolved active Section root (the
controller's authorizeTool resolves the context). Since Phase 2E2 the
substates DIFFER: the checkpointed active section regains
`request_completion` (restored — precise blockers surface instead of a hidden
operation), while a revisionless active section — no checkpoint to complete —
does not; both gain `request_section_focus`.

Since Phase 2F the SYNTHESIS column is likewise resolved into STRUCTURED
SUBSTATES derived from the latest derived artifacts: `synthesis/no-input` (no
frozen SynthesisInput), `synthesis/input-ready` (input frozen, no manifest),
and `synthesis/manifest-ready` (at least one manifest revision). The
controller's authorizeTool resolves the substate from the store.

Since Phase 2G the manifest-ready substate splits on the CURRENT validation
report (the successful report bound to the exact current input+manifest
identity): `synthesis/manifest-ready, unvalidated` (no such report),
`synthesis/validation-findings`, and `synthesis/validation-clean` — FIVE
substates total. Historical reports bound to superseded identities pick NO
substate. Since Phase 2H the validation-clean substate splits on the CURRENT
FinalPlanCandidate (bound to the exact current gate identity): a CURRENT
candidate picks `synthesis/final-candidate-ready` (the minimal recheck
surface); a stale candidate falls back to validation-clean — SIX substates
total. Staleness of a candidate is DERIVED on every resolution, never stored.
Since Phase 2I the final-candidate-ready substate splits on the CURRENT
final_plan Proposal (ready/awaiting_approval and bound to the CURRENT
candidate): a current final Proposal picks
`synthesis/final-proposal-ready`, which NARROWLY grants
`request_user_approval` (§22) — SEVEN substates total. Currency of the
Proposal binding is likewise derived, never stored; a stale Final Proposal
falls back to final-candidate-ready (prepare is idempotent) and is refused
pre-ask at the approval boundary itself.

| Capability | no run | discovery | architecture | detail decomp-needed | detail section-ready (both substates) | synthesis no-input | synthesis input/manifest-ready (unvalidated) | synthesis validation-findings | synthesis validation-clean | synthesis final-candidate-ready (current candidate) | synthesis final-proposal-ready (current final Proposal) | final | handoff_pending | completed/aborted |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| start_or_resume | ✓ | ✓¹ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓² |
| read_status | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| read_memory | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| record_question | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| propose_question_resolution | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| raise_conflict | — | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| promote_evidence | — | ✓ | ✓ | ✓ | ✓ | — | — | — | — | — | — | — | — | — |
| request_architecture | — | ✓ | — | — | — | — | — | — | — | — | — | — | — | — |
| prepare_proposal | — | — | ✓ | ✓ | ✓ | — | — | — | — | — | — | — | — | — |
| prepare_decomposition | — | — | — | ✓ | — | — | — | — | — | — | — | — | — | — |
| prepare_section_checkpoint | — | — | — | — | ✓ | — | — | — | — | — | — | — | — | — |
| request_section_focus | — | — | — | — | ✓ | — | — | — | — | — | — | — | — | — |
| request_user_approval | — | — | ✓ | ✓ | ✓ | — | — | — | — | — | ✓¹⁰ | — | — | — |
| request_completion | — | — | ✓ | — | ✓⁴ (checkpointed only) | — | — | — | — | — | — | — | — | — |
| begin_synthesis | — | — | — | — | — | ✓ | ✓⁶ | — | ✓⁶ | — | — | — | — | — |
| submit_synthesis_manifest | — | — | — | — | — | — | ✓ | ✓⁷ | ✓ | — | — | — | — | — |
| run_semantic_validation | — | — | — | — | — | — | ✓ | ✓ | ✓ | — | — | — | — | — |
| request_reopen | — | — | — | — | ✓⁸ | — | — | ✓ | — | — | — | — | — | — |
| request_finalization | — | — | — | — | — | — | — | — | ✓⁹ | ✓⁹ | ✓⁹ | — | — | — |
| prepare_final_plan | — | — | — | — | — | — | — | — | — | ✓¹⁰ | ✓¹⁰ (idempotent) | — | — | — |
| request_synthesis | — | — | — | — | — | —⁵ | —⁵ | —⁵ | —⁵ | — | — | — | — | — |

¹ With an active run present, `ultraplan_start` RESUMES it (never creates a second).
² Creates a NEW run (completed/aborted runs are terminal).
⁴ Restored in Phase 2E2 for the CHECKPOINTED active section only; a
revisionless active section has no checkpoint to complete (no meaningful
completion), and `kind="section"` outside detail fails deterministically.
⁵ Phase 2E2 §30 + Phase 2H §55: the old PROVISIONAL request_synthesis
synthesis→final gate is WITHHELD permanently — it must never bypass the real
pipeline (SynthesisManifest → semantic validation → Evidence Audit →
Finalization Gate → FinalPlanCandidate). Even a CLEAN ValidationReport and a
PASSING finalization do not make this shortcut meaningful: the synthesis →
final edge belongs to the Final PlanCommit (a later phase), and the
capability is granted nowhere.
⁶ Phase 2F §17: `begin_synthesis` stays granted in the no-input, unvalidated,
and validation-clean substates DELIBERATELY — a repeated freeze at the same
HEAD must return the SAME input (idempotent, never a duplicate), and only a
fresh freeze can replace a stale input after a future HEAD change (§18/§51).
⁷ Phase 2G (§66 interpretation): manifest REVISIONS stay available past a
findings report — a genuinely revised manifest creates a NEW validation
identity and a NEW judgment (the anti-laundering rule's sanctioned
alternative to reopening design). It can never re-roll the existing report.
⁸ Phase 2G §49: the DEPENDENCY-REVIEW reopen — a sanctioned review loop for
approved Sections invalidated by a dependency change (validation =
needs_review). Still Proposal → user Approval → `reopen_section` PlanCommit;
never a direct status change.
⁹ Phase 2H §52: `request_finalization` is granted ONLY in
synthesis/validation-clean (request deterministic finalization) and
synthesis/final-candidate-ready (idempotent retrieval/recheck of the current
candidate) — never in findings/unvalidated state. A pass leaves the stage at
synthesis and grants no authority beyond the derived candidate itself. Since
Phase 2I it is likewise granted in synthesis/final-proposal-ready (idempotent
recheck while the Final Proposal is pending — a drifted state demotes the
substate and the stale Proposal is refused at the approval boundary).
¹⁰ Phase 2I §49/§50/§22: `prepare_final_plan` is granted in
synthesis/final-candidate-ready (freeze the exact final_plan Proposal from
the CURRENT candidate) and stays granted in
synthesis/final-proposal-ready ONLY for idempotent retrieval of the existing
Proposal (§19). `request_user_approval` is granted in synthesis ONLY in
synthesis/final-proposal-ready — i.e. only for a CURRENT exact final_plan
Proposal (ready, or awaiting_approval for resumable presentation); the
controller independently re-verifies the proposal's type, candidate binding,
and current gate identity BEFORE any user-facing confirmation (§57), and the
transaction engine reruns the gate with exact identity equality at commit
(§25-§27). Ordinary synthesis proposals can never use this approval path.

Rationale highlights:

- discovery has no conflicts/proposals: no design exists yet to conflict about;
  it gains exactly ONE workflow operation — requesting the transition to
  architecture (Phase 2C §10/§11). Readiness is STRUCTURAL only (active run,
  stage=discovery, structured goal present, no prior architecture workflow);
  the frontier model decides WHEN it knows enough, the Harness decides whether
  the request is LEGAL. No inspection-count/evidence-count heuristics exist;
- `request_completion` in architecture is architecture-scoped ONLY
  (`kind="architecture"` — Phase 2C §24); sections cannot even be named there;
- **detail/decomposition-needed** (`sections = []`): the model can read, ask,
  raise conflicts, promote evidence, and freeze the initial decomposition —
  but Section completion/reopen are WITHHELD so no tool can pretend a Section
  exists before the DAG is committed (Phase 2D §23);
- **detail/section-ready** (Phase 2E1 §20 + 2E2 §48 + 2G §49): the Section
  DESIGN surface — `prepare_section_checkpoint` targets `run.activeWork` (first
  checkpoint = `add_section_revision`, later = exact `amend_section`);
  `request_section_focus` (Phase 2E2 §20) sanctions discussion ahead of
  dependency completion; `prepare_decomposition` stays withheld
  (initial-only). The CHECKPOINTED substate additionally regains
  `request_completion`: the capability is exposed even when deterministic
  blockers exist so the Harness can return precise errors rather than making
  the operation mysteriously disappear (2E2 §7). Since Phase 2G §49 both
  section-ready substates carry the DEPENDENCY-REVIEW reopen (approved +
  needs_review targets only); the reopen applies only by user-approved
  `reopen_section` PlanCommit;
- **synthesis/no-input** (Phase 2F §43): the real Synthesis workflow begins —
  reads + harmless blocker-raising + `begin_synthesis` (the Harness freezes
  the HEAD-anchored SynthesisInput). NO design mutation, NO reopen, NO
  finalization authority, and NO provisional `request_synthesis` shortcut
  (2E2 §30);
- **synthesis/input-ready + manifest-ready (unvalidated)** (Phase 2F §43 +
  2G §33/§34): the derived OUTPUT surface — `submit_synthesis_manifest`
  (derived content only: cross-section links, implementation order,
  limitations, findings, all with exact provenance) plus, once a manifest
  exists, `run_semantic_validation` (NO arguments — the Harness resolves the
  exact input+manifest pair and invokes the isolated validator itself).
  Synthesis/validation artifacts are `derived_artifact` authority: their
  creation requires no Approval, creates no PlanCommit, and never moves HEAD;
- **synthesis/validation-findings** (Phase 2G §36): the report is blocking and
  the sanctioned way back to design opens — `request_reopen` for an exact
  affected SectionRevision (user-approved `reopen_section` PlanCommit), plus
  idempotent validation retrieval and manifest REVISIONS for a genuinely
  changed synthesis output (new identity, new judgment — §66). No design
  mutation, no provisional finalization;
- **synthesis/validation-clean** (Phase 2G §35 + Phase 2H §52): a clean
  report restores NO design mutation and does NOT by itself grant final
  authority — reads, harmless blocker-raising, idempotent validation
  retrieval, the idempotent re-freeze, and (Phase 2H) `request_finalization`
  are available; the gate, not the model, decides;
- **synthesis/final-candidate-ready** (Phase 2H §53/§54): a CURRENT
  FinalPlanCandidate exists — the MINIMAL recheck surface (reads, harmless
  blockers, `request_finalization` for idempotent retrieval). The candidate
  is NOT user approval and does NOT authorize Build; a stale candidate falls
  back to validation-clean;
- `final` is read-only: Final approval is USER authority; handoff is Harness authority;
- `handoff_pending` exposes no planning mutation — recovery/handoff operations are
  Harness-internal (not model tools at v0.1).

---

## 5. Tool Input/Output Contracts

All tools accept JSON args validated by zod schemas (`src/tools/registry.ts`) and return
structured results:

```text
success: { title, output, metadata: { ...ids, state flags } }
failure: { title: "Ultra Plan <error_code>",
           output: "ERROR [<error_code>] <message>",
           metadata: { errorCode, detail? } }
```

Machine-readable error codes (see `core/errors.ts`): `no_active_run`,
`capability_not_available`, `invalid_stage_transition`, `invalid_lifecycle_transition`,
`invalid_scope`, `unknown_reference`, `revision_mismatch`, `missing_provenance`,
`proposal_type_invalid`, `proposal_kind_unsupported`, `proposal_immutable`,
`finalization_blocked`, `dependency_incomplete`, `phase_boundary`, `goal_required`
(Phase 2C — discovery cannot complete without a structured goal), plus the Phase 1
domain codes, the Phase 2A.1 codes: `start_not_authorized`,
`proposal_not_approvable`, `proposal_status_invalid`, `approval_mismatch`, and the
Phase 2C transaction-level failure codes reported inside
`transaction_validation_failed`: `completion_missing` (architecture_completion
proposal without a complete_architecture change), `completion_type_invalid`
(complete_architecture inside another proposal type), `completion_stage_invalid`
(completion attempted outside stage=architecture), `completion_target_mismatch`
(completion target ≠ resulting committed Architecture revision), and the Phase 2D
transaction-level failure codes: `decomposition_stage_invalid` (decomposition
changes outside stage=detail), `architecture_scope_mismatch` (decomposition
scope ≠ the run's exact committed ArchitectureRef), `decomposition_already_committed`
(initial decomposition is initial-only), and the Phase 2E1 transaction-level failure
codes: `checkpoint_stage_invalid` (Section checkpoint changes outside stage=detail),
`checkpoint_scope_invalid` (a checkpoint change whose target is not the proposal's
exact SectionRef, or not the run's `activeWork`), and the Phase 2E2 completion /
progression codes: `section_completion_missing` (section_completion proposal without
a complete_section change), `section_completion_type_invalid` (complete_section
inside another proposal type), `section_completion_stage_invalid` (completion
outside stage=detail), `revision_missing` / `revision_mismatch` (no approved
checkpoint, or divergent root pointers, or a target ≠ the exact current approved
revision), `section_needs_review` (validation gate), `no_eligible_section`
(work remains but no unfinished Section has all dependencies approved — fail
closed), `sections_not_valid` (synthesis entry requires every Section valid),
`evidence_not_fresh` (critical evidence reachable via SectionRevision → Decision
→ Evidence), plus the harness error `stale_active_work` (a focus transition
whose expected focus no longer matches — cross-instance CAS, fail closed), and
the Phase 2F derived-artifact codes: `synthesis_entry_invalid` (a structural
entry gate failed — wrong lifecycle/stage, uncleared focus, unapproved or
invalid Section set, or live state drifted from HEAD), `synthesis_input_missing`
(submission with no frozen input — the tool path denies this at the capability
gate; the code guards direct paths), `synthesis_input_stale` (submission
against an input whose baseSnapshot ≠ current HEAD — the input stays readable
but accepts no new manifest), `provenance_missing` (a derived statement with
zero sources), `provenance_invalid` (a source outside the frozen input, a
historical non-input revision, or an unsupported ref form),
`cross_section_invalid` (a link citing fewer than two DISTINCT Sections),
`implementation_coverage_gap` (an approved SectionRevision missing from the
implementation order), `implementation_order_violation` (a Section before its
dependency), and `finding_invalid` (an unknown finding category), plus the
Phase 2G semantic-validation / reopen codes: `synthesis_manifest_missing`
(validation with no manifest bound to the current input),
`validator_unavailable` (no validator runtime is bound to the harness —
honest failure, never a fabricated report), `validation_already_running`
(the single-flight admission is held by a live same-process execution),
`validation_output_invalid` (strict parse / structural report rejection — an
EXECUTION FAILURE, not findings: nothing is persisted and retry is allowed),
`validation_identity_changed` (the identity moved between admission and
persist), `validation_report_missing` (a synthesis reopen without a current
findings report), `reopen_reason_invalid` (a clean report or unknown finding
ids cannot authorize a reopen — plus the engine-side inner codes
`reopen_type_invalid` / `reopen_scope_invalid` / `reopen_stage_invalid` /
`reopen_target_invalid` / `reopen_report_mismatch` / `reopen_report_stale`),
and `reopen_target_unsupported` (no selected finding affects the exact target
SectionRevision — an Architecture-level finding cannot be falsely resolved
through a Section reopen).

Phase 2H finalization codes: `finalization_stale` (the authoritative state —
HEAD, synthesis identity, validation report, or reachable Evidence state —
moved between the audit/gate and the candidate freeze, or a live blocking
question/conflict appeared; nothing partial is persisted — re-resolve from
current state; the gate's blocked/stale OUTCOMES are structured VALUES, not
errors, delivered by `ultraplan_request_finalization` with the exact machine
blockers/staleness codes).

`plan_memory` read semantics (spec §20):

- `kind=architecture` — latest committed architecture, or EXACT revision when given;
- `kind=section` — committed Section node, or exact SectionRevision when `revision` given;
  the SectionRevision carries its contract projection canonically
  (`projection.contract` — Phase 2E1 keeps ONE immutable contract value per
  revision; there is no separately mutable contract object to read);
- `kind=decision` — exact revision REQUIRED (approved decisions are immutable);
- `kind=evidence|question|conflict|proposal` — resolved from run/evidence state;
- `kind=synthesis_input` — a frozen derived input by EXACT id (Phase 2F §41;
  historical inputs never resolve to latest — the id IS the identity);
- `kind=synthesis_manifest` — a derived manifest by id; with `revision` an
  EXACT historical read (a missing revision is an error, never resolved to
  latest), without it the newest revision of that manifest id;
- `kind=validation_report` — a semantic-validation report by EXACT id
  (Phase 2G §59; an unknown id is an error, NEVER resolved to the current
  report — the current report is discoverable from status and the L0
  projection);
- `kind=evidence_audit` — an Evidence Audit snapshot by EXACT id (Phase 2H
  §56; an unknown id is an error, never resolved to the current audit);
- `kind=final_plan_candidate` — a FinalPlanCandidate by id; with `revision` an
  EXACT historical read (a missing revision is an error, never resolved to
  latest or to the current candidate), without it the newest revision of that
  candidate id (Phase 2H §56);
- `kind=final_plan` — the committed FinalPlan by id (Phase 2I §47); with
  `revision` an EXACT historical read (a missing revision is an error, never
  resolved to latest), without it the newest revision of that FinalPlan id.
  A FinalPlan exists only after a final_plan PlanCommit; before that, the
  read is an `unknown_reference` error;
- `dependenciesOf=<SEC-…>` — the section plus its dependency Section ROOTS and,
  where a dependency has an approved checkpoint, its EXACT approved
  SectionRevision (with the contract). A dependency without an approved
  revision returns its root only — the absence is explicit and is never
  fabricated into an empty contract (Phase 2E1 §26);
- an explicit historical revision that does not exist is an `unknown_reference`
  error — it is NEVER silently resolved to HEAD/latest. "Current revision" is
  resolved by reading the Section root's `currentRevision` pointer and then
  that exact revision — no fuzzy latest resolution exists.

## 6. Proposal Authority Boundary

The model may PREPARE proposal candidates; the Harness does everything authoritative:

- Harness assigns `ProposalID` (model never names authoritative objects);
- Harness binds the proposal to the active run, validates scope against run state,
  and binds `createdFrom` to the current HEAD snapshot;
- the change vocabulary at this boundary is CLOSED:
  `add_decision, amend_decision, amend_section, add_architecture, add_constraint,
  raise_question, resolve_question, complete_architecture, complete_section`
  — other kinds are rejected with `proposal_kind_unsupported`;
- kind/type/stage legality is enforced (`proposal_type_invalid`):
  `architecture_completion` only in architecture and MUST contain
  `complete_architecture` (and nothing else may contain it); `add_architecture`
  only in architecture; `section_completion` only in detail; `design_checkpoint`
  in architecture/detail; `amendment` in architecture/detail;
- `final_plan` proposals are NOT tool-creatable (synthesis workflow owns them);
- proposals are created directly in `status="ready"` and are content-frozen: the
  Harness computes a canonical SHA-256 hash; the proposal is immutable from creation
  (`proposal_immutable` on any reuse) — v0.1 has no draft-editing workflow, so the
  spec's "frozen at awaiting_approval" boundary is entered early by construction.

**Approval lifecycle boundary (frozen for Phase 2B, Correction C):** a `ready`
Proposal is NOT directly approvable and not committable. Before the user is asked,
the Harness atomically transitions the exact frozen proposal
`ready → awaiting_approval` (`beginProposalApproval` /
`PlanStore.transitionProposalStatus`; only `status` may change, content is
immutable). The approval hash does NOT change during that transition: the hash is
computed over the canonical approval payload
(`transaction/hash.ts::proposalApprovalPayload`: id, revision, type, scope, title,
summary, changes, dependencies, impact, createdFrom — `status` and `hash` are
excluded; object keys sorted lexicographically, arrays kept in semantic order,
`undefined` dropped, SHA-256 over the canonical serialization). Golden hash tests
pin this contract.

## 7. Approval Authority Boundary

- Approval is USER authority. There is NO model-visible approval tool and there never
  will be one.
- An approval must eventually bind `{ proposalID, proposalRevision, proposalHash,
  actor: "user" }` (spec §9.3). The hash computed at proposal preparation makes this
  binding verifiable: what the user approves is exactly what the transaction engine
  would commit.
- **Implemented gateway (Phase 2B1):** `ultraplan_request_user_approval` presents
  a READY proposal — `ready → awaiting_approval` — then blocks on the real
  `ToolContext.ask` one-shot confirmation (permission string embeds
  `proposalID@revision:hashPrefix`; metadata carries the full binding; `always` is
  empty). Allow → the immutable Approval is recorded (idempotent on duplicate
  delivery) and the transaction engine commits atomically. Deny → the proposal is
  rejected: no Approval authorization, no commit, no HEAD movement. The tool
  accepts ONLY a proposalID — there are no decision arguments for the model to
  forge.
- **Approval persistence semantics:** an Approval is immutable and idempotent
  (same binding → the same record; conflicting binding → `approval_mismatch`).
  Recording an Approval does NOT mark the proposal approved — it STAYS
  `awaiting_approval` until `commitTransaction` succeeds, so a crash after
  approval resumes deterministically from the persisted Approval. Retrying an
  already-committed exact transaction returns the existing PlanCommit (zero
  duplicates); a conflicting approval for an already-committed proposal fails
  with `already_committed`.
- **One user decision ↔ one exact ProposalID ↔ one exact proposalRevision ↔ one
  exact proposalHash.** Any binding mismatch is rejected with `approval_mismatch`;
  a decision against a proposal that is not `awaiting_approval` fails with
  `proposal_not_approvable`. There is NO persistent/"always" approval: OpenCode's
  `ToolContext.ask` exposes an "always allow" concept via its `always` patterns, so
  the approval gateway contract FORBIDS passing any `always` pattern — a persistent
  permission can never become a standing approval authority.
  `ApprovalRequest.oneShot: true` is the type-level commitment; the request carries
  no pattern/persistence fields.
- Verified OpenCode mechanisms for routing a structured user confirmation
  (re-verified in 2A.1 from the installed types): `ToolContext.ask({
  permission, patterns, always, metadata }): Promise<void>` — resolves on allow,
  rejects on deny (deny is signaled by rejection, not a return value); `metadata`
  survives into the `Permission` record, so a unique proposal/hash binding can ride
  in the permission string and metadata; the `permission.ask` hook and the
  `permission.replied` event provide the structured reply path. Phase 2B design
  consequences: present the confirmation with an empty `always` list, and carry
  `{ proposalID, proposalRevision, proposalHash }` in the metadata. Arbitrary
  conversational phrases ("looks good") are NEVER parsed as approval.

## 7.1 Explicit Plan Entry Admission (Phase 2A.1 Correction B)

```text
user invokes /ultra-plan
        ↓ command.execute.before   (real OpenCode hook; the model cannot invoke it)
Harness records a one-shot StartAdmission
        (session-scoped, command-specific, TTL 10 min, consumed on use)
        ↓
model invokes ultraplan_start
        ↓
Controller consumes the matching admission → create/resume PlanningRun
```

- No valid admission → deterministic `start_not_authorized`; a direct tool or
  controller invocation without the command creates nothing.
- One admission per `/ultra-plan` invocation; consumed admissions cannot be
  reused; an admission for session A cannot start session B.
- Terminal runs (completed/aborted): a NEW run requires a fresh explicit command.
- `handoff_pending`: `/ultra-plan` resumes/reports the same run; recovery/handoff
  stays Harness-authoritative and is never re-entered by the tool.
- Agent-side tool exposure (the planning agent's `tools` map) is defense-in-depth
  only — never the authorization mechanism.
- Natural-language prompt content ("the user invoked /ultra-plan") and model-supplied
  arguments are never accepted as proof of entry.

## 7.2 Question Resolution Boundary (Phase 2A.1 Correction A)

```text
model reasons about a question
        ↓ ultraplan_propose_question_resolution
OpenQuestion.proposedResolution = { text, proposedAt }     ← working state
question.status REMAINS "open" (blocking questions stay blocking)
        ↓
Proposal containing resolve_question → explicit user approval → PlanCommit (2B)
        ↓
question.status = resolved; resolution/resolvedBy applied  ← authoritative
```

Before a valid approved PlanCommit: the blocking question remains blocking. The old
`ultraplan_resolve_question` tool is deleted and listed in `FORBIDDEN_TOOL_NAMES` —
there is no compatibility path that silently resolves a question.

## 7.3 Completion / Reopen Authority (Phase 2A.1 audit)

- `ultraplan_request_completion` prepares a completion proposal intent — since
  Phase 2C in TWO scopes through ONE semantic operation (`kind`):
  `kind="architecture"` (architecture stage only) freezes an
  `architecture_completion` proposal containing `complete_architecture` at the
  EXACT committed Architecture revision; `kind="section"` (detail stage) keeps
  the `section_completion` behavior. It never marks an Architecture or Section
  approved/complete — completion is applied only by a PlanCommit. Completion
  preconditions are architecture-specific and deliberately NOT the Final Plan
  finalization predicate: no requirement for approved sections, fresh critical
  evidence, or zero blocking questions (Detail has not started; non-final
  architectural uncertainty is preserved — `Architecture.unresolved` exists).
- `ultraplan_request_reopen` prepares an `amendment` proposal intent. The
  `reopened` Section status is COMMITTED-artifact state (changing it modifies
  approved-state semantics), so the model can never apply it directly; it is
  applied by the PlanCommit carrying the amendment. Reopen targets must resolve
  against exact references.

## 7.4 Discovery → Architecture Request (Phase 2C)

```text
DISCOVERY (goal understood, questions/evidence recorded)
        ↓ ultraplan_request_architecture   (model REQUESTS — no arguments)
Harness validates structural readiness:
  active run · stage == discovery · structured goal present
  · no prior architecture workflow
        ↓ transitionStage(discovery → architecture) + run.stage_changed event
ARCHITECTURE
```

- The model NEVER sets a stage. `set_stage` / `ultraplan_force_stage` do not
  exist and are forbidden names. The request either succeeds deterministically
  or fails with `capability_not_available` / `goal_required`.
- Discovery readiness is STRUCTURAL only. There are deliberately no heuristics
  ("must inspect N files", "must hold N evidence items") — the frontier model
  decides when it has enough understanding to REQUEST progression.
- **Goal semantics:** `PlanningRun.goal` is USER-authored. It originates from
  the arguments of an explicit `/ultra-plan` invocation (transmitted by the
  command template), becomes durable at `createRun`, and a later /ultra-plan
  invocation may FILL an empty goal but never overwrite an existing one. Model
  prose is never accepted as the authoritative goal, and no approval proposal
  is required because the statement is the user's own working-state input.
- L0 protocol guidance is stage-derived: discovery guidance (explore, promote
  evidence, record questions, request architecture when ready) and architecture
  guidance (top-level design; no section design yet; freeze → approval) are
  static fragments selected by `run.stage` — never model-generated.

## 7.5 Architecture Proposal + Persistence + Completion (Phase 2C)

**Architecture input contract (closed typed shapes, no DSL):**

```text
architecture draft = {
  summary: string (non-empty)
  components:  [{ name, summary }]            (names unique)
  boundaries:  [{ name, description }]        (names unique)
  dataFlows:   [{ from, to, description }]
  principles:  [{ statement }]
  unresolvedQuestionIDs?: QuestionID[]   → resolved against run open questions
                                            (or raise_question changes earlier
                                            in the SAME proposal)
  basedOn?: DecisionID[]                 → resolved against committed decisions
                                            (or add_decision changes earlier in
                                            the SAME proposal)
}
```

These freeze the smallest meaningful v0.1 shapes of the spec's `Component`,
`Boundary`, `DataFlow`, `Principle` support types. All references are resolved
at proposal FREEZE time — the frozen Architecture carries no dangling ids.

**Persistence semantics:**

- `add_architecture` is the INITIAL path only: `ARCH@1`. The Harness assigns
  `id="ARCH"`, `revision=1`, and freezes `status="approved"` so the user
  approves the exact resulting object; the commit engine writes it VERBATIM —
  no content is generated or rewritten during commit. A second
  `add_architecture` (committed Architecture exists) is rejected at freeze
  (`invalid_scope`) and again by the engine (`change_invalid`). Amendment/reopen
  of an existing Architecture is later-phase work; nothing silently replaces a
  committed Architecture.
- The approval hash covers the FULL Architecture body: any change to a
  component, boundary, data flow, principle, the summary, a decision reference,
  or an unresolved item changes the hash (golden-hash pinned). The hash binds
  the exact payload, not an ArchitectureRef with a mutable body elsewhere.
- **Checkpoint vs completion (frozen distinction):** a `design_checkpoint` may
  commit `add_architecture` (plus decisions/constraints/questions) and the run
  STAYS in stage=architecture with `ARCH@1 approved` committed. Only a
  successful `architecture_completion` PlanCommit completes the Architecture.
- **Completion = stage transition, atomically:** the
  `architecture_completion` PlanCommit applies its changes, sets
  `PlanningRun.architecture` to the exact committed ref, moves
  `stage: architecture → detail`, appends `run.stage_changed`, materializes the
  Snapshot, creates the PlanCommit, and moves HEAD — all in ONE durable
  transaction publication. There is no separate `saveRun(stage=detail)` and no
  committed `architectureCompleted` flag; after a restart the run recovers
  DIRECTLY in detail. Engine guards: `completion_missing`,
  `completion_type_invalid`, `completion_stage_invalid`,
  `completion_target_mismatch` (see §5). No other proposal type, tool, or event
  can move `architecture → detail`.
- **Approval presentation is deterministic (§19):** before `ToolContext.ask`,
  the gateway renders the frozen Proposal into a compact projection
  (`renderProposalForApproval` — identity, revision, per-change content
  including components/boundaries/data flows/principles/decision refs/
  constraints, and the approval hash). It is a pure function of the hashed
  payload — never model-generated prose — so what was hashed is what the user
  saw. Architecture approval reuses `ultraplan_request_user_approval`; there is
  no architecture-specific bypass.

## 7.6 Constraint Authority Resolution (Phase 2C)

```text
model identifies a candidate constraint (conversation / proposal draft)
        ↓ add_constraint inside a Proposal  (Harness assigns CON-###, freezes
          status="active"; duplicates of an active statement are refused)
        ↓ explicit user approval
        ↓ PlanCommit
committed Constraint (PlanningRun.constraints — commit-gated run state)
```

- There is NO working-state constraint tool. `PlanningRun.constraints` is a
  COMMIT-GATED run field: a model-inferred constraint can never become
  authoritative by calling a working-state operation — `saveRun` refuses any
  change to it with `commit_gated_run_field`. The only path in is the approved
  `add_constraint` PlanCommit above.
- Natural-language limitation preserved from Phase 2B1: a stored hard
  constraint is NOT a mechanically proven hard constraint. The planning model
  may reason against stored constraints; the user may approve them as design
  constraints; only structurally expressible constraints are mechanically
  enforced. No LLM call exists inside `commitTransaction` to "validate"
  natural-language constraints.

## 7.7 Detail Decomposition (Phase 2D)

**Tool decision (brief §25/§26):** a DEDICATED tool,
`ultraplan_prepare_section_decomposition`, freezes the complete initial DAG.
`add_section` / `select_initial_section` are deliberately NOT part of the
generic `ultraplan_prepare_proposal` vocabulary — loose incremental section
creation ("add SEC-001 → commit → add SEC-002 → commit") cannot express, and
can never produce, a partially committed initial DAG. The dedicated input is
the strongest typed boundary with zero duplication of the proposal machinery.

```text
DETAIL / decomposition-needed (stage=detail, sections=[], activeWork=none)
        ↓ ultraplan_prepare_section_decomposition
input: { sections: [{ key, title, objective, dependsOn[] }], initialSection }
        ↓ Harness (everything authoritative, §3):
  validate draft shape (≥1 section; unique keys; known dependency keys;
    no self edges; no duplicate edges; dependencies reference EARLIER keys;
    known initialSection)                      → §17 freeze-time DAG gate
  assign SEC-### via the durable allocator (draft order = canonical order)
  resolve dependsOn keys → exact SectionID edges
  freeze Section roots pending/valid, no revisions
  freeze select_initial_section at the exact resolved SectionRef
  scope the proposal to the EXACT committed ARCH@N (never "latest")
        ↓
one design_checkpoint Proposal (v0.1 representation per brief §5 — no new
proposal type: the decomposition is a coherent architecture-derived design
checkpoint that establishes the Detail graph) → hash covers the FULL DAG:
ids, titles, objectives, edges, order, initial focus
        ↓ explicit USER approval → one atomic PlanCommit
committed Section DAG + PlanningRun.sections + PlanningRun.activeWork
+ Snapshot (with sectionRoots) + HEAD — together, or nothing
```

- **Draft-local keys** (`runtime-integration`, `plan-memory`, …) exist only in
  the tool input so edges and the initial focus can be expressed before
  authoritative identities exist. They are never persisted as identities. The
  dependency-forward rule (dependencies appear EARLIER in the array) keeps the
  approved order canonical and makes cycles unrepresentable; the existing
  `assertAcyclicSections` invariant still gates freeze and commit.
- **Section root, not Section design (§46):** decomposition creates
  `status:"pending"`, `validation:"valid"`, revision-less Section roots. No
  SectionRevision, no SectionContract, no revision pointer is fabricated —
  contracts belong to approved Section design (Phase 2E).
- **Initial focus (§12/§13):** `initialSection` is a draft key resolved to an
  exact SectionRef and frozen as `select_initial_section` inside the hashed
  Proposal. It does NOT need zero dependencies (discussion is not gated on
  dependency approval — approval is a completion constraint). There is no
  generic `set_active_work`; `activeWork` is a commit-gated run field
  established only by this commit.
- **Initial-only (§19):** with a committed DAG the capability is withheld
  (`capability_not_available`) and the engine independently refuses
  (`decomposition_already_committed`); rejection commits nothing and a new FULL
  decomposition may be proposed (the allocator may re-issue the uncommitted
  SEC range; a rejected Proposal is never renumbered).
- **Commit-time revalidation (§18):** the engine re-checks stage=detail, exact
  architecture scope, initial-only, fresh ids, staged-resolvable edges, no
  self edges, acyclicity, and that the initial focus exists in staged state —
  hostile/direct engine calls fail with `transaction_validation_failed` +
  `decomposition_stage_invalid` / `architecture_scope_mismatch` /
  `decomposition_already_committed` / `change_invalid` / `unknown_reference`.
- **Snapshot representation (§27/§29):** `SnapshotState.sectionRoots` records
  the committed DAG (exact ids, titles, objectives, dependency edges, root
  status, CANONICAL ORDER) even with zero SectionRevisions. The field is
  ADDITIVE and optional: older snapshots legitimately predate decomposition
  and are read unchanged — absence is meaningful, never backfilled — so
  STORE_SCHEMA_VERSION stays 1 with no migration.
- **`plan_memory` (§30):** Section roots read without a revision;
  `dependenciesOf=<SEC>` returns structural dependency roots even before
  contracts exist. The completion dependency rule
  (`assertSectionCanComplete`) is unchanged and regression-tested.
- **Status (§35):** detail renders `Sections: not decomposed` /
  `Active work: none` before the DAG, and `Sections: N (a approved)` /
  `Active work: SEC-###` after — deterministic projections, never prose.
- **L0 (§34):** the protocol's detail guidance is substate-derived —
  decomposition instructions before the DAG; the active Section's id/title and
  direct dependencies plus "next workflow is Section design" after it.

## 7.8 Section Checkpoint (Phase 2E1)

**Tool decision (brief §7):** a DEDICATED tool,
`ultraplan_prepare_section_checkpoint`, means exactly: "freeze the ACTIVE
Section's detailed design into the next exact SectionRevision checkpoint
Proposal." `add_section_revision` is deliberately NOT part of the generic
`ultraplan_prepare_proposal` vocabulary, and no loose incremental
revision-creation tool exists — a SectionRevision can only be born from the
active-work discipline with Harness-assigned identity.

- **Target discipline (§7):** the operation accepts no authoritative section
  id. It targets `run.activeWork` (a section focus). The engine INDEPENDENTLY
  refuses a checkpoint change whose target differs from the proposal's exact
  SectionRef scope or from `run.activeWork`
  (`checkpoint_scope_invalid`) — the controller and engine enforce the same
  narrow workflow.
- **First vs later revision (§5/§6/§43):** a revision-less root freezes
  `add_section_revision` (resulting revision 1); a root at `currentRevision =
  N` freezes `amend_section` superseding the EXACT prior revision
  `SEC-X@N`, resulting `@(N+1)` — no "amend latest" ambiguity. No path may
  `add_section_revision` a section that already has revisions, or
  `amend_section` a revision-less one (engine: `change_invalid` /
  `unknown_reference`). Proposal type stays `design_checkpoint`, scoped to the
  exact SectionRef (no new proposal type exists).
- **Input contract (§8):** a CLOSED typed draft — `problem`, `design`,
  `interfaces` (unique-name `InterfaceSpec`s), `invariants`, `failureModes`,
  `dependencies` (`{sectionID, consumes}` per structural dependency),
  `decisions`/`openQuestions`/`impacts` (ids that must already resolve),
  `projection.compact`, `projection.contract`. No `content: unknown`, no
  revision identity fields — hostile authoritative fields cannot be expressed
  and are never honored.
- **Dependency binding (§12/§14):** `Dependency.contractRevision` is
  Harness-assigned at freeze: for each structural dependency with an approved
  checkpoint, the EXACT approved contract revision is bound (the user approves
  "designed against exactly SEC-X@N"); a dependency without an approved
  revision carries NO binding (explicit absence, never "latest"). The draft
  must record the root's structural dependencies EXACTLY (missing, extra,
  duplicate, and self edges are `invalid_scope`), and a `consumes` name must
  be provided by the bound contract (`invalid_scope`).
- **Contract consistency (§11):** validated deterministically at freeze, no
  LLM at freeze or commit: contract `invariants` must restate revision
  invariants; contract `interfaces` must resolve to revision-defined
  interfaces (`providedBy`, if given, must be the section itself); contract
  `decisions` must resolve to committed decisions referenced by the revision
  at their exact committed revisions. `provides`/`requires` are EXPLICIT
  approved projection content — they are not claimed to be mechanically
  proven by prose.
- **Stable projections (§9):** full design + compact projection + contract are
  ONE approval payload inside the hashed Proposal; the commit writes the
  revision VERBATIM. Compact and contract are never regenerated after
  approval and never re-summarized per context build.
- **Root status semantics (§4/§16/§17):** `pending` = no approved
  SectionRevision; `active` = ≥1 approved revision, completion not yet
  committed; `approved` = Section completion committed (Phase 2E2); `reopened`
  = later reopen (Phase 2E2+); `awaiting_approval` is RESERVED and is never
  persistently toggled — `beginProposalApproval` does not mutate Section
  roots; the root changes only inside PlanCommit. A first checkpoint sets
  `status = active`, `currentRevision = approvedRevision = 1`; a later
  checkpoint moves both pointers to the new revision. `activeWork` is
  unchanged by checkpoints; the stage remains `detail`.
- **`approvedRevision` ≠ completion (§18):** `approvedRevision` means
  "latest user-approved SectionRevision checkpoint". A root may be
  `active` with `currentRevision = approvedRevision = 3` and still be
  incomplete. Checkpoint approval is NOT Section completion.
- **Validation rule (§13/§15/§34-§36):** the engine recomputes
  `validation` from STAGED state, never from approved content: `valid` only
  when every structural direct dependency has an approved contract at commit
  time; a missing dependency contract leaves the root `needs_review` while the
  checkpoint still commits (design may proceed ahead of dependency completion;
  COMPLETION gating is Phase 2E2). Committing a checkpoint (first contract
  appearing or contract revision changing) propagates `needs_review` to
  already-designed downstream revisions; nothing downstream is deleted or
  regenerated — a new reviewed checkpoint binds the current contracts and
  restores `valid`. There is no `mark_valid` tool: validation follows from
  approved revisions and their bindings.
- **Completion deferral (§19):** `request_completion(kind="section")` and
  `request_reopen` are WITHHELD from every detail substate in Phase 2E1
  (deterministic `capability_not_available` phase-boundary failure). The
  engine's `complete_section` staging and `assertSectionCanComplete` remain
  intact and regression-tested; no partial completion semantics were
  implemented.
- **Snapshot/durability (§27-§29):** `SectionRootSnapshot` gained additive
  optional `currentRevision`/`approvedRevision`; the root DAG
  (`sectionRoots`) is kept. Restart reconstructs DAG structure + revision
  state without conversation history. Additive optional fields →
  STORE_SCHEMA_VERSION stays 1 (no incompatible change; fail-closed shape
  validation extended).
- **Commit-time revalidation (§37):** the engine re-checks stage=detail, exact
  section scope, activeWork target, first-vs-later discipline, contract
  identity (`sectionID`/`revision` stamped with the revision's own), binding
  sanity against staged dependency state, and recomputes validation —
  hostile/direct engine calls fail with `transaction_validation_failed` +
  `checkpoint_stage_invalid` / `checkpoint_scope_invalid` / `change_invalid` /
  `unknown_reference`.
- **Status (§33):** detail renders `Section: SEC-### pending|active`,
  `Revision: none | SEC-###@n approved checkpoint`, and
  `Validation: valid|needs_review` — deterministic projections; "Section
  completed" is never rendered in Phase 2E1.
- **L0 (§31/§32):** detail guidance names the active section (title,
  objective, direct dependencies, each dependency's contract availability
  approved@n / no contract yet, current checkpoint + validation), the
  design checklist, and the checkpoint tool. No Context Assembler, no token
  budgeting, no ContextTrace (later phases).

## 7.9 Section Completion & Work Progression (Phase 2E2)

**Tool decision (brief §6):** NO new completion tool exists — the model
requests completion through the SAME `ultraplan_request_completion` with
`kind="section"` (restored from the Phase 2E1 narrowing). The model supplies
no authoritative inputs (no revision/status/dependencies): the Harness
resolves `activeWork` -> root -> exact current approved revision and freezes
the `section_completion` Proposal with the closed `complete_section` change.

- **Completion != checkpoint (§3):** a `design_checkpoint` approves an exact
  design revision; a `section_completion` authorizes ONLY "the current exact
  approved SectionRevision is sufficiently complete to become a closed
  dependency". The completion change carries NO design content — the
  committed revision and its canonical contract are never regenerated,
  re-approved, or duplicated; completion creates NO new SectionRevision.
- **Exact target (§4):** the freeze requires `root.status == active`,
  `currentRevision == approvedRevision` (both present), and binds
  `complete_section.target = SEC-X@approvedRevision` — inside the Proposal
  hash. No "complete latest" resolution exists; the engine independently
  re-validates the target against staged state
  (`completion_target_mismatch`).
- **Deterministic gates (§8-§11)** — validated at freeze AND independently at
  commit, reusing `assertSectionCanComplete` (never replaced):
  the §9 dependency gate (every structural dependency root `status ==
  approved` — a dependency checkpoint alone is insufficient) takes precedence
  when both gates fail; then the §10 validation gate (`validation == valid`;
  a `needs_review` Section re-checkpoints against current dependency
  contracts first — NO force_complete/ignore_validation flags exist); plus
  contract identity (the completed revision's contract is stamped with its
  own section+revision) and dependency-binding freshness against staged
  state.
- **Evidence reachability (§12):** completion fails closed when critical
  repository Evidence is reachable through the ONLY chain the domain
  currently represents — target SectionRevision -> referenced committed
  Decisions -> their Evidence refs — and is not fresh. No global repository
  scan, no speculative reachability.
- **No global question gate (§13):** blocking OpenQuestions do NOT block
  Section completion (they block FINALIZATION); the engine's existing
  blocking-conflict validation for relevant refs still applies (§14).
- **Root result (§15-§17):** one atomic commit sets `status: active ->
  approved` with `currentRevision`/`approvedRevision` unchanged and
  `validation: valid`; no `awaiting_approval` root toggle ever happens
  (Proposal status represents transient approval state); rejection and
  commit failure mutate nothing and the Approval stays retriable/idempotent.
- **activeWork authority (§19):** `activeWork` remains a commit-gated run
  field — generic header mutation stays forbidden and `set_active_work`
  still does not exist. The refinement: committed DESIGN mutation is
  distinct from Harness-controlled WORKFLOW FOCUS transitions. Two sanctioned
  paths exist: automatic progression INSIDE the completion PlanCommit, and
  the narrow `transitionActiveWork(planID, expected, next)` store operation
  behind `ultraplan_request_section_focus`.
- **Manual focus switching (§20-§23):** `ultraplan_request_section_focus`
  targets a committed pending|active Section of the run (never
  approved/reopened — 2E2 flow); it is workflow state, NOT a Proposal, and
  requires NO user approval (discussion order != completion order; dependency
  completion is NOT required to discuss/design a Section). The durable
  transition revalidates the EXPECTED current focus authoritatively under
  the durable write lock — cross-instance stale transitions fail closed with
  `stale_active_work` (no last-writer-wins drift). It appends ONE
  `run.active_work_changed` event (workflow audit, not a PlanCommit);
  in-commit progression is auditable through `PlanCommit.changes` and needs
  no redundant event.
- **Deterministic next-work selection (§24-§26):** inside the SAME staged
  transaction, after a successful completion: eligible = Sections in
  CANONICAL (Phase 2D committed) order with `status != approved` AND every
  structural dependency approved; next = first eligible. The model is never
  asked, no quality/ranking heuristics exist. Discussion may jump ahead, but
  automatic progression follows dependency closure. If work remains and the
  eligible set is empty -> fail closed (`no_eligible_section`) — never pick
  arbitrarily, never escape to synthesis.
- **Atomicity (§27-§28):** one PlanCommit publishes Section approved + next
  activeWork + Snapshot + events + HEAD together (no post-commit focus
  saveRun). When the completion closes the LAST Section AND every Section is
  `valid`, the SAME commit clears `activeWork` and moves detail -> synthesis.
  An all-approved-but-invalid DAG fails closed (`sections_not_valid`).
- **Synthesis admission is NOT finalization (§29-§31):** entering synthesis
  means only "the committed Detail design set is closed enough to begin
  synthesis" — no Final Plan, no validation pass, no `checkFinalization`
  call, no SynthesisManifest. The synthesis capability surface is minimal
  and safe (reads + blocker-raising); the provisional `request_synthesis`
  synthesis->final gate is WITHHELD until the real Synthesis workflow exists.
- **Snapshot (§35):** `SnapshotState.activeWork` (additive, optional) records
  the workflow focus after the commit — the next Section after an ordinary
  completion, absent on the final completion (meaningful absence).
  STORE_SCHEMA_VERSION stays 1.
- **Status (§36):** detail renders `Completion: ready` or
  `Completion: blocked` + `Reason: <first deterministic blocker>` for the
  checkpointed active Section; synthesis entry renders `Stage: synthesis`,
  `Active work: none`, `Sections: all approved`.
- **L0 (§37-§38):** checkpointed guidance names whether completion is ready
  or blocked (with the blocker and the focus tool); a static synthesis
  placeholder forbids new design facts and finalization requests until
  Phase 2F.

## 7.10 Frozen Synthesis Input & Provenance-bound Synthesis Manifest (Phase 2F)

Phase 2F implements the real Synthesis workflow as a DERIVED-ARTIFACT domain
(frozen architecture §31: "Synthesis is a projection of approved design, not
another uncontrolled design phase"):

- **Derived-artifact authority class (§5):** `derived_artifact` — may create
  immutable derived workflow artifacts, must NEVER mutate committed Plan
  Memory. Both synthesis tools carry it; `mutatesCommittedMemory` stays
  `false`; creation requires NO Proposal → Approval → PlanCommit and NEVER
  moves HEAD (§48/§49). SynthesisInput/SynthesisManifest are durable,
  immutable, content-hashed, exact-ref-based, and auditable — but NOT new
  normative design facts.
- **SynthesisInput (§6/§7):** frozen by `ultraplan_begin_synthesis`, which
  accepts NO authoritative refs. The Harness validates the deterministic
  structural entry gates (active run, stage=synthesis, activeWork cleared,
  HEAD snapshot present, exact approved Architecture, every Section root
  approved + valid with a resolvable exact approvedRevision and a
  self-identity-stamped canonical contract — blocking questions/conflicts are
  deliberately NOT required), then resolves every exact ref FROM THE HEAD
  SNAPSHOT: the approved `ARCH@n`, every approved Section at its exact
  revision in canonical DAG order (never "latest"), the exact committed
  Decision revisions HEAD represents, the committed Constraint records HEAD
  binds (identity-only domain — no invented revisions), frozen copies of the
  OPEN Question/Conflict state (they may be unresolved — that is their
  purpose), and the Evidence state reachable through the one chain the domain
  represents (Architecture/SectionRevision → Decisions → Evidence; exact
  revisions + confidence/criticality/freshness/status — NOT the global
  Evidence Audit).
- **Canonical hash + idempotency (§16/§17):** the input hash covers the
  complete authority payload (base Snapshot, Architecture, Section
  set/order, Decision refs, Constraint set, frozen Question/Conflict state,
  Evidence state) and EXCLUDES id/createdAt/hash itself — so a repeated
  freeze at the same authoritative state returns the SAME input (store-level,
  in-lock: races serialize into ONE canonical current input, §55). A new HEAD
  (future reopen cycle) means a NEW input; the old input remains immutable
  historical (§18/§51). The mandatory staleness authority in Phase 2F is the
  HEAD Snapshot mismatch — no second live-fingerprint system exists (§19).
- **Deterministic synthesis capsule (§21):** the begin response renders the
  frozen input deterministically — no model inference; Section designs appear
  through their stable `projection.compact`/`projection.contract` (reused,
  never re-summarized, §10); the Architecture renders deterministically from
  its approved structured content (§11); full revisions remain available
  through `plan_memory` (kind=`synthesis_input`, exact id).
- **SynthesisManifest (§22-§24):** submitted by
  `ultraplan_submit_synthesis_manifest`, which accepts ONLY derived content:
  `crossSectionLinks` (each citing ≥ 2 DISTINCT Sections through exact refs,
  §26), `implementationOrder` (typed steps; the Harness derives the step
  number from array order — the model never supplies one, §27),
  `limitations` (derived statements with provenance, §30), and
  `unresolvedFindings` (v0.1 categories `contradiction | missing_design |
  missing_dependency | coverage_gap`, §31). The Harness supplies identity,
  revision, input binding, base Snapshot, Architecture ref, Section set, and
  hash. The shape has NO authority fields (no approved/final/newDecisions/
  newConstraints/architectureChanges, §35) and NO user Approval status (§48).
- **Structural validation, fail closed (§33):** on submission the Harness
  independently validates — input exists, belongs to the plan, is CURRENT
  (`run.headSnapshot == input.baseSnapshot`, else `synthesis_input_stale`;
  re-validated under the durable write lock), every source ref resolves
  EXACTLY against the frozen input (findings may additionally cite blockers
  raised after the freeze, §53), every derived statement carries ≥ 1 source
  (`provenance_missing`/`provenance_invalid`), the cross-section rule,
  implementation-order coverage (every approved SectionRevision appears in
  ≥ 1 step; duplicate participation is PERMITTED by the documented rule, §28),
  and deterministic Section-DAG order (for SEC-B depends on SEC-A, first
  occurrence of SEC-A ≤ first occurrence of SEC-B — same-step grouping is
  acceptable; `implementation_order_violation`). No LLM validates ordering.
- **STRUCTURAL ≠ SEMANTIC (§34):** Phase 2F proves "this statement cites
  exact approved inputs", coverage, and ordering. It CANNOT prove entailment:
  unsupported new facts, contradictions, and incorrect derivations belong to
  the Phase 2G semantic validator. The manifest is described as STRUCTURALLY
  valid — never "semantically validated".
- **Immutable revisions + idempotency (§36/§37):** one stable manifest id per
  SynthesisInput with Harness-assigned contiguous revisions (SYN-001@1 → @2);
  prior revisions stay immutable/readable. Exact-content resubmission returns
  the existing revision (never a duplicate).
- **Manifest hash (§38):** covers the derived content payload (input binding,
  base Snapshot, inputHash, Architecture, Section set, links, steps with
  derived order, limitations, findings) excluding id/revision/createdAt/hash
  — golden-tested; it becomes Phase 2G validator identity input.
- **Persistence (§39/§40):** two ADDITIVE durable families
  (`synthesisInputs`/`synthesisManifests`) — absence in pre-2F documents is
  unambiguous, so STORE_SCHEMA_VERSION stays 1. Durable loading fails closed:
  stored hashes must recompute, the manifest's input must exist and be
  mirrored exactly (baseSnapshot/architecture/sections), revision chains must
  be contiguous, provenance refs must use supported exact forms. No
  auto-repair.
- **Reads (§41):** `plan_memory` reads derived artifacts —
  `kind=synthesis_input` (exact id) and `kind=synthesis_manifest`
  (id + optional exact revision; historical revisions are NEVER resolved to
  latest). The current active input/manifest is discoverable from status.
- **No stage transition (§44):** freezing an input and saving a manifest do
  NOT change stage; the run remains synthesis until Phase 2G defines the next
  transition. Synthesis substates are resolved from artifacts, not a new
  persisted stage (§43).
- **Status (§47):** `Synthesis input: not frozen | SYN-IN-###` +
  `Base: SNAP-###` + `Synthesis manifest: none | SYN-###@n` +
  `Manifest status: structurally valid` + `Semantic validation: not run`;
  a stale input renders `Input status: stale (HEAD moved past SNAP-###)`.
  Phase 2F NEVER renders `Validation: clean` or `Final: ready`.
- **L0 (§45/§46):** the synthesis guidance states the authority boundary
  (MAY organize/connect/order/normalize/record; MUST attach exact provenance
  and preserve approved facts; MUST NOT invent design or claim validation)
  plus the minimal projection (input identity/base/hash, manifest ref/hash,
  staleness, open blocker count).

## 7.11 Event Vocabulary (Phase 2C + 2D + 2E1 + 2E2 + 2F)

Phase 2C required no new event types: stage movement (both
discovery→architecture and the completion transition) produces the established
`run.stage_changed`; `add_architecture`/`add_constraint` produce
`artifact.revised` (the kind union gained `"constraint"`); the completion
commit, its stage event, and `head.moved` are durable in the same publication.
Phase 2D adds exactly one: `section.added` (sectionID, title, dependencies) —
real audit meaning (the DAG was created), durable in the decomposition
publication; the initial-focus selection is auditable through
`PlanCommit.changes` (`select_initial_section`).
Phase 2E1 requires NO new event types either: a committed Section checkpoint
produces `artifact.revised` with kind `"section_revision"` (already part of
the frozen vocabulary since 2B1) and is auditable through `PlanCommit.changes`
(`add_section_revision` / `amend_section` with the exact resulting revision).
The contract projection is structurally part of the committed SectionRevision
(one canonical immutable value), so it deliberately has no separate event;
root pointer/validation movement is visible in the snapshot and
`PlanCommit.changes`.
Phase 2E2 likewise adds NO completion event: a Section completion is
auditable through `PlanCommit.changes` (`complete_section` at the exact
revision) plus the HEAD snapshot (`SectionRootSnapshot.status` flips to
`approved`; the snapshot's `activeWork` records the deterministic next
focus). The ONE new event is `run.active_work_changed` (from, to) — appended
ONLY by the manual focus transition (`ultraplan_request_section_focus`),
which is workflow state outside any PlanCommit; automatic in-commit
progression is fully covered by the commit chain and deliberately emits no
redundant event. The detail -> synthesis movement on the last completion uses
the established `run.stage_changed` inside the same publication. There is no
`section.completed` event — `PlanCommit.changes` + artifact state carry the
fact without duplication.
Phase 2F adds exactly TWO events, both Harness-workflow audit for DERIVED
artifacts (never a PlanCommit, never HEAD movement):
`synthesis.input_frozen` (inputID, hash, baseSnapshot) — appended once per
actually-frozen input (an idempotent re-freeze emits nothing new); and
`synthesis.manifest_saved` (manifestID, revision, inputID, hash) — appended
once per actually-created revision (an exact-content replay emits nothing
new). Design-memory semantics stay untouched: no `artifact.revised` is
emitted for synthesis artifacts because committed Plan Memory did not change.
Phase 2G adds exactly ONE event: `validation.report_saved` (reportID, result,
inputID, manifestID, manifestRevision, hash) — appended once per actually
persisted ValidationReport (findings and clean share the same durable
mechanism and event shape; an anti-laundering replay emits nothing new, and
execution failures emit nothing because nothing was persisted). The
single-flight admission deliberately has NO event: it is transient
machinery, auditable through the durable document, not workflow authority.
A REOPEN is committed design state: the `reopen_section` PlanCommit is
auditable through `PlanCommit.changes` and the HEAD snapshot
(`SectionRootSnapshot.status` flips to `reopened`; `activeWork` records the
target; `run.stage_changed` records synthesis → detail) — no new event type
is added, mirroring the Phase 2E2 completion precedent.

Phase 2H adds exactly TWO events: `finalization.audit_saved` (auditID,
result, blockers, evidenceStateHash, hash) and
`finalization.candidate_saved` (candidateID, revision, auditID, hash) —
appended once per actually persisted derived artifact; an idempotent
identity replay emits nothing new. Finalization deliberately has NO commit /
HEAD / stage events: audits and candidates are derived workflow artifacts
(brief §42), and their creation is auditable through these events and the
durable document families alone.

## 7.12 Read-only Semantic Validation & Section Reopen Admission (Phase 2G)

Phase 2G closes the STRUCTURAL ≠ SEMANTIC gap left by Phase 2F — without a
persisted `validation` stage (the frozen `PlanningStage` union is untouched;
semantic validation is durable derived state: `stage = synthesis` +
ValidationReport, agent protocol §9) and without finalization authority:

- **Validator authority is detector-only (§5), enforced structurally (§5/§60):**
  the validator classifies `unsupported_new_fact | contradiction |
  missing_design | missing_dependency | incorrect_derivation | coverage_gap |
  clean`. No validator output path can create Proposals/Approvals/PlanCommits,
  write design, resolve questions/conflicts, reopen sections, set stages, move
  HEAD, or create a FinalPlan — the report shape cannot express any of it and
  the only route back to design is the user-approved `reopen_section`
  PlanCommit. The report is `derived_artifact` authority, NOT Plan Memory
  design.
- **The model can never declare validity (§6):** there is NO
  `ultraplan_submit_validation_report`. `ultraplan_run_semantic_validation`
  accepts NO arguments and NO report content: the Harness resolves the exact
  current (SynthesisInput, latest-manifest-for-that-input) pair (§11/§12 —
  non-stale input, hashes recompute, manifest mirrors the input, both current),
  invokes the validator over a deterministic ValidationCapsule, parses the
  output STRICTLY, validates the report structure independently, and persists
  the immutable report.
- **Validator runtime boundary (§7-§10):** the Core depends only on the narrow
  `SemanticValidator` interface (`validate(capsule) → raw output`); the OpenCode
  runtime adapter owns the invocation: ONE ephemeral Harness-owned session
  (not user planning state, no history, deleted after extraction), ONE prompt
  with the frozen `semantic-validation:v1` system prompt and the capsule as
  the only user content, and per-request tool disabling. Isolation is
  STRUCTURAL: the validator session is not the PlanningRun owner, so every
  harness tool in that session fails `no_active_run`; the tools map disables
  all `ultraplan_*` and repository/shell builtins as defense-in-depth. The
  documented limit: the v1.18 tools map disables tools BY NAME (no verified
  "disable-all" wildcard) — the structural session-boundary guarantee does
  not depend on it. No child-session API beyond the verified
  `session.create`/`session.prompt`/`session.delete` triple is assumed; no
  generic subagent framework is built.
- **Strict output parsing (§17/§67):** exactly one JSON document — markdown
  fences, surrounding prose, duplicate keys (hand-rolled parser; JSON.parse
  silently keeps the last), unknown fields, NaN/Infinity, wrong enums, wrong
  types, empty strings, malformed refs/locators, and validator-supplied
  finding ids are ALL rejected (`validation_output_invalid`). No permissive
  fallback extraction exists.
- **Structural report validation (§13/§23):** the Harness independently
  verifies every scope/manifest-item/source reference resolves EXACTLY
  against the current input/manifest, the closed locator forms are within
  bounds (§21 — 1-based `cross_section_link`/`limitation`/`synthesis_finding`
  indices and `implementation_step` orders; no JSONPath), finding ids are
  Harness-assigned (VF-###), cardinality holds (`clean` ⇔ findings = ∅), and
  a manifest declaring `unresolvedFindings` can NEVER be reported clean —
  even if the validator says so (§13 fail-closed).
- **ValidationReport contract (§18-§20/§24):** immutable, canonical-hashed
  (same stableStringify+SHA-256 contract; hash covers planID, input
  ref+hash, manifest ref+hash, baseSnapshot, protocol, recorded model,
  result, findings INCLUDING Harness-assigned ids; excludes id/createdAt/
  hash). `clean` is a report RESULT, never a finding category (§19). Golden
  hash pinned. Stored reports recompute their hash at durable load and fail
  closed on any mismatch/mirror break/category/scope/locator violation
  (§29) — additive `validationReports`/`validationAdmissions` document
  families, absence unambiguous, STORE_SCHEMA_VERSION stays 1 (§28).
- **Anti-laundering (§25/§66):** the identity is (inputHash, manifestHash,
  validatorProtocol). Once a successful report exists for an identity,
  `run_semantic_validation` returns it — the validator is NOT invoked again
  (tested). A new judgment requires a genuinely changed design or manifest
  revision (new identity). Changing validator semantics later requires a new
  protocol version (§16) — itself a new identity.
- **Execution failure ≠ findings (§26):** model/API/parse/structure failures
  persist NOTHING (no report, no findings) and stay retryable; the L0/status
  surfaces never mistake them for validation results.
- **Single-flight admission (§30-§32/§64):** the durable write lock is NEVER
  held across model inference. Under the lock: completed-report check →
  owner-stamped, expiring admission (dead processes' admissions are
  reclaimable by pid/expiry — never a wedge, never a clean result); the
  validator runs unlocked; the report persists under the lock with FULL
  identity revalidation, so racing instances converge on ONE successful
  report and a live same-process double-run fails
  `validation_already_running`.
- **Synthesis capability substates (§34-§36):** FIVE substates — no-input,
  input-ready, manifest-ready/unvalidated (+ `run_semantic_validation`),
  validation-findings (+ the restored `request_reopen`), validation-clean
  (NO design mutation restored; reads, blocker-raising, idempotent
  retrieval). A report bound to a SUPERSEDED identity picks no substate.
- **Sanctioned Section reopen (§37-§53):** `ultraplan_request_reopen` is
  restored narrowly — synthesis (semantic_validation: current report must be
  `findings`; the Harness resolves the exact approved revision; ≥1 selected
  finding must affect that exact SectionRevision, else
  `reopen_target_unsupported` — Architecture-level findings stay blocking and
  architecture reopen remains an explicit later requirement) and detail
  (dependency_review: approved + needs_review targets; no report needed).
  The frozen intent is the closed `reopen_section` change (NOT part of the
  generic proposal vocabulary) binding the exact target revision, report
  id/hash, and finding ids inside the `amendment` Proposal hash (§40/§42).
  The approval view renders the deterministic SECTION REOPEN projection
  (§43). The user-approved `reopen_section` PlanCommit atomically performs
  (§44): status approved → reopened, validation → needs_review, pointers
  UNCHANGED (no new revision — §45), stage synthesis → detail,
  activeWork → target, Snapshot/PlanCommit/HEAD. Reports and findings stay
  historical (§51). The reopened section checkpoints through the EXISTING
  `prepare_section_checkpoint` flow (§46): its amendment returns the root to
  `active` (normal incomplete-design state, §47), downstream approved
  sections re-inherit `needs_review` through the unchanged
  `propagateNeedsReview` when the new revision/contract commits (§48), and
  the run re-enters synthesis through the EXISTING detail-completion
  progression (§52) — new HEAD → new input → new manifest → new validation
  identity.

## 7.13 Evidence Audit, Deterministic Finalization Gate & Final Plan Candidate (Phase 2H)

Phase 2H replaces the Phase 1 infrastructure placeholder (`checkFinalization`)
with the ONE deterministic finalization authority — no model call anywhere,
and still NO persisted `validation`/`final` state (the gate is re-evaluated
from CURRENT state on every request; §29):

- **Evidence Audit is a derived workflow artifact (§5/§14):** the immutable,
  canonical-hashed `EvidenceAuditSnapshot` binds AT MINIMUM the PlanID, the
  exact HEAD Snapshot/Commit, the exact synthesis identity (input id+hash,
  manifest id+revision+hash), the current clean ValidationReport id+hash, the
  audited entries, diagnostic counts, the closed result/blockers, and the
  canonical `evidenceStateHash` over the reachable Evidence state (§10:
  exact referenced revision, state fields, `derivedFrom` refs, represented
  source-provenance identities — never repository contents). Creating one
  requires no Proposal/Approval/PlanCommit and moves HEAD nowhere; a BLOCKED
  audit persists deliberately (§46) as the auditable explanation of the
  evidence term.
- **Audit reachability (§7):** exactly the relationships the domain
  represents — HEAD snapshot → design anchors (exact Architecture revision
  `basedOn`, exact approved SectionRevisions' `decisions`, and the
  snapshot's committed-decision bindings) → exact Decision revisions →
  their `evidence` refs. The repository is never scanned; uncited Evidence
  is ignored; every citation path is preserved and deduplicated (§67).
- **Exact evidence references (§8):** a pinned ref (EVD-017@2) is audited at
  @2 — never silently rebased to a newer revision; when a newer revision
  exists the audit flags `evidence_revision_mismatch` and fails closed.
- **Evidence state vs HEAD (§9/§26):** Evidence is a separate trust domain
  and can change without moving Plan HEAD. The audit cross-checks every
  evidence state frozen into the SynthesisInput against the record's CURRENT
  newest revision (`synthesis_evidence_stale`), and the gate re-checks the
  audit's `evidenceStateHash` against a live recompute on EVERY request
  (`evidence_audit_stale`) — semantic validation against state A can never
  be finalized against silently changed state B. Recovery follows the
  existing synthesis loop: re-observed evidence yields a NEW revision, a
  re-freeze at the same HEAD freezes a NEW input (new evidence states), and
  the new identity requires a fresh manifest + validation + gate.
- **Frozen gate semantics (§11):** critical Evidence blocks unless
  status=active AND freshness=fresh AND confidence≠uncertain; supporting
  Evidence conservatively blocks unless status=active AND freshness=fresh
  (the state model has no other revalidation signal); informational
  Evidence is RECORDED (state + counts) but never blocks by itself — the
  architecture §30 rule, documented here as the exact interpretation.
- **Blocker vs staleness, never conflated (§15/§28):** blocked = semantic
  deficiencies of the CURRENT state (closed codes: lifecycle/stage/
  activeWork/head, architecture terms, section approval/review/revision/
  contract terms, missing synthesis identity, manifest mirror/finding terms,
  non-clean validation, missing/blocked audit, live blocking questions/
  conflicts with exact ids); stale = the world moved on (synthesis input,
  manifest, validation report, audit identity/evidence fingerprint,
  synthesis-consumed evidence state). STALE takes precedence: re-resolve,
  never rebase (§47). No caller may force anything (§27).
- **FinalPlanCandidate authority (§30-§43):** on a PASS, the immutable
  candidate is assembled DETERMINISTICALLY (no model call, no new normative
  prose) from approved Plan Memory + the current manifest (implementation
  order and limitations copied EXACTLY, §33/§34) + the clean report + the
  passing audit, binding exact committed refs (never "latest", §35/§36).
  Its hash covers the full authority payload excluding
  id/revision/createdAt/hash (§37); id/revision are store-assigned in-lock
  so concurrent instances converge on ONE candidate identity (§38/§73);
  revisions are one stable immutable family (FPC-001@1, FPC-001@2, …, §39).
  A candidate is NOT a Proposal, NOT user authorization, NOT the FinalPlan:
  it sets no `PlanningRun.finalPlan` (§40), transitions no stage (§76 —
  synthesis → final belongs to the Final PlanCommit, a later phase), moves
  no HEAD (§42), and authorizes no Build. Its currency is DERIVED (§51):
  status shows `Final candidate: current|stale`, never mutating the stored
  candidate.
- **`ultraplan_request_finalization` (§4/§45):** accepts NOTHING from the
  model; resolves the current identity → builds/reuses the audit
  (identity-keyed idempotency, §17) → evaluates the pure gate → blocked/stale
  return exact machine reasons (no candidate, no stage transition, no HEAD
  movement) → pass freezes/reuses the candidate and returns the
  deterministic preview (§43 — a projection, never canonical state, §44).
  The in-lock store save revalidates full currency (audit ↔ live evidence
  fingerprint, live blockers) so a racing evidence write or live blocker
  fails `finalization_stale` with zero partial state (§48/§49/§50/§68/§69).

## 7.14 Formal Final Proposal, Final Approval & Final PlanCommit (Phase 2I)

Phase 2I closes the planning loop: the CURRENT FinalPlanCandidate becomes the
formally user-approved, committed FinalPlan — through the SAME
Proposal → Approval → PlanCommit machinery as every other committed design,
with the Finalization Gate re-run at every authority boundary. The runtime
Build handoff is explicitly NOT part of this phase.

- **The Final Approval stage interpretation (§3):** while a final_plan
  Proposal exists — ready, awaiting_approval, even approved-but-uncommitted —
  the run STAYS at stage=synthesis / lifecycle=active. The boundary is the
  Proposal's type+status, never a premature stage change: evidence,
  questions, conflicts, the manifest, and the report may all move while the
  user is considering the Proposal, and keeping the run in synthesis avoids a
  stale `final` state that would need an unsafe reverse transition. Only the
  successful Final PlanCommit performs stage synthesis → final AND lifecycle
  active → handoff_pending, atomically (§34/§36/§37). (Implementation-layer
  interpretation; the frozen architecture document is unmodified.)
- **`add_final_plan` (§5/§16):** the smallest transaction vocabulary — legal
  ONLY inside `Proposal.type = "final_plan"`, and a final_plan Proposal
  carries EXACTLY ONE change: the complete exact resulting FinalPlan payload.
  Final approval can never smuggle in a decision, constraint, question,
  section amendment, reopen, or architecture change; if design must change,
  the normal reopen → synthesis → validation → candidate → new Proposal loop
  is the only path.
- **`ultraplan_prepare_final_plan` (§6/§7):** proposal_intent, input EMPTY.
  The Harness reruns the deterministic Finalization Gate (never trusting
  "the candidate was valid when created"), requires the CURRENT candidate,
  projects the FinalPlan through the ONE shared `buildFinalPlanFromCandidate`
  (§33 — the engine recomputes the same projection at commit, so a hostile
  direct transaction with a tampered payload fails
  `final_proposal_stale`), assigns FINAL-###@n (§9 — initial-only, §10), and
  freezes the Proposal scoped to the candidate's exact ARCH@n (§17). A stale
  candidate or a blocked/stale gate refuses preparation (§8) — the sanctioned
  loop is `request_finalization` → current candidate → `prepare_final_plan`.
- **Proposal binding (§17/§18):** the Proposal hash covers the complete
  FinalPlan payload (candidate ref+hash, base HEAD snapshot, FINAL id/revision,
  all exact refs, order, limitations, validation/audit identities, and the
  deterministic body projection) — changing ANY of it changes the hash and
  invalidates any prior Approval. Idempotency (§19): the same current
  candidate reuses its ready/awaiting Proposal; a rejected Proposal is never
  resurrected (a new explicit preparation is allowed — user approval is
  required again either way).
- **Standard Approval protocol (§21/§22/§24/§57):** NO new approval primitive
  — the exact ProposalID + proposalRevision + proposalHash + actor=user
  binding, `ToolContext.ask` with `always: []`, one-shot. `request_user_approval`
  is granted in synthesis ONLY for a CURRENT final_plan Proposal; before any
  user-facing confirmation the Harness re-verifies the binding and the
  current gate identity (`final_proposal_stale` pre-ask refusal — an obsolete
  confirmation is never shown). On allow the immutable Approval persists and
  the Proposal STAYS awaiting_approval until the commit succeeds (crash-safe,
  Phase 2B1 semantics); on deny the Proposal is rejected with no Approval, no
  FinalPlan, no stage/lifecycle change (§23/§54).
- **The MANDATORY second gate (§25/§26/§27):** after user authorization and
  IMMEDIATELY before mutation, the TRANSACTION ENGINE itself reruns the pure
  FinalizationGate — not trusting the controller, the pre-Proposal result, or
  even a generic fresh pass: the current FinalizationIdentity must EQUAL the
  user-approved candidate's identity (HEAD, input, manifest id/revision/hash,
  report hash, audit hash, live evidence fingerprint). Evidence drift (§28),
  new blocking questions/conflicts (§29), manifest revision drift (§30),
  validation identity drift (§30), and candidate drift (§31) each make the
  commit refuse (`finalization_stale` / `finalization_blocked` /
  `final_proposal_stale`) with zero state change and the Approval left
  durable and unmutated (§55/§56 — its historical statement stays true; a new
  Proposal requires a NEW approval).
- **Final PlanCommit effects (§34/§36-§43):** ONE atomic publication writes
  the immutable FinalPlan (`status: "approved"`, `approvedAt` = the exact
  Approval.createdAt — system transaction metadata, never model-authored),
  `PlanningRun.finalPlan` = the exact ref, stage = final, lifecycle =
  handoff_pending, the Snapshot (carrying `finalPlanRevision`), the PlanCommit
  (`add_final_plan FINAL-###@n`), the approved Proposal, the events, and HEAD
  last. No post-commit saveRun exists; `finalPlan` remains a commit-gated run
  field (§41).
- **Handoff_pending ≠ Build (§38/§52/§80):** at Phase 2I exit the execution
  model is NOT switched, no agent is switched, no ExecutionHandoff is
  delivered, no Build turn is injected, and `lifecycle` is NOT completed —
  only `read_status`/`read_memory` remain model-visible. Durable load
  validation fails closed on every impossible state (pointer without record,
  record without pointer, handoff_pending without the final commit, snapshot
  missing the finalPlan ref, approved final Proposal without its commit,
  tampered payload/projection — §70-§74).
- **Competing/concurrent proposals (§58-§60):** two instances preparing the
  same identity converge on one Proposal; an exact duplicate
  Proposal+Approval delivery replays the ONE commit (§59); after a winner
  commits, every competing Final Proposal is refused and no second FinalPlan
  can ever exist (§60).

## 7.15 Recoverable ExecutionHandoff & Same-session Build Transition (Phase 2J)

Phase 2J closes the v0.1 authority chain: a handoff_pending run is recovered,
an immutable ExecutionHandoff is deterministically frozen, and the runtime
Build turn is dispatched into the SAME OpenCode session under the configured
execution role — after which `PlanningRun.lifecycle` becomes `completed`. The
handoff is a RECOVERABLE SIDE-EFFECT workflow, not another PlanCommit.

- **Runtime mechanism (§2-§4, audited against @opencode-ai/plugin 1.18.x):**
  ONE host-native call — `session.prompt_async` (POST /session/{id}/prompt_async,
  documented by the host as `204 "Prompt accepted"`) — carries the execution
  `agent`, the execution `model {providerID, modelID}`, and the handoff parts
  together, targeting exactly `PlanningRun.sessionID`. The async variant is
  chosen deliberately: the synchronous `session.prompt` resolves only after
  the full assistant response, which would conflate handoff DELIVERY with
  Build EXECUTION (§105 — `completed` means Ultra Plan's handoff is done, NOT
  that implementation finished). Confirmation does NOT rely on the 204: the
  created user message is OBSERVED through `session.messages` (history query)
  carrying the stable marker, and the host-recorded `agent`/`model` of that
  message become the receipt.
- **ExecutionHandoff (§6-§16) is a derived workflow artifact** — deterministically
  projected from the approved immutable FinalPlan + the run goal + exact
  referenced Plan Memory; NO model call, no new design facts, no planning
  conversation. ONE canonical handoff per FinalPlan (HANDOFF-###, recovery
  reuses it, never HANDOFF-002); exact refs only (ARCH@n, SEC-###@n,
  DEC-###@n); one EXACT canonical SectionContract per exact approved
  SectionRevision; the documented critical-decision rule is "ALL FinalPlan
  DecisionRefs" (no criticality marker exists, so no heuristic); exact
  validated limitations; a closed set of structural validation requirements;
  canonical hash excluding id/createdAt/hash. The handoff is NEVER rewritten
  after delivery (§50), and the FinalPlan always wins over the projection (§9).
- **HandoffDelivery (§19/§20) is the mutable workflow record** —
  prepared → dispatching → delivered, with an attempt counter and the host
  receipt. `prepared` is durable BEFORE the first dispatch (outbox intent,
  §38); `delivered` means the exact handoff message was OBSERVED in the
  target session history (§23) — never merely "the request returned 200".
  The immutable handoff never carries runtime state.
- **deliveryKey (§21):** `<planID>/<HANDOFF-###>/<handoffHash>` — stable,
  embedded as a `delivery-key=` marker line in the payload, and used as the
  host history-lookup key. A caller-controlled request id exists in the host
  API types but its acceptance semantics are undocumented on 1.18.x, so it is
  deliberately NOT relied on; marker search is the idempotency/confirmation
  mechanism.
- **Same-session invariant (§27/§28):** the dispatch targets exactly
  `PlanningRun.sessionID`; no model/tool argument can supply session,
  workspace, provider, agent, or model as authority — they come from the
  PlanningRun and adapter configuration. A receipt naming another session is
  REFUSED (`handoff_session_mismatch`).
- **Execution model/agent policy (§29/§30/§57-§59):** deterministic role
  policy from adapter configuration — the execution agent defaults to the
  HOST-NATIVE Build agent ("build"), the execution model defaults to the
  session's host default (a documented safe default); an explicitly-empty
  configuration leaves the handoff pending with `execution_policy_unresolved`.
  No prompt-complexity routing; the planning model is never reused for Build.
- **No model-facing handoff authority (§35/§109):** there is NO handoff tool.
  The Harness recovery/continuation path performs the handoff deterministically
  (the session-idle event hook and the /ultra-plan resume path). The user's
  Final Approval was the only authorization needed.
- **Single-flight + ambiguity (§24/§39-§45/§62/§119-§121):** the dispatch
  admission is a CAS (`prepared → dispatching`, attempt + 1) under the durable
  write lock — two instances converge on ONE dispatch. NO store lock is held
  across the host call (§40). A stale `dispatching` is resolved by HOST
  EVIDENCE first (§43): receipt found → delivered + completed (no resend);
  host definitively does not show it → safe re-dispatch; query unavailable or
  failing → fail closed as `handoff_delivery_ambiguous`, run stays
  handoff_pending. Definite pre-acceptance rejection (§61) returns the
  delivery to `prepared` (retryable). Deliveries are never marked delivered
  without a real receipt, and silent dispatching→delivered repair never
  happens (§88).
- **Lifecycle completion (§46-§49/§106):** `completeHandoffRun` is a narrow
  Harness-owned workflow transition (never a Proposal/PlanCommit; generic
  `set_lifecycle` stays forbidden) requiring: handoff_pending + stage final +
  exact approved FinalPlan + a handoff binding it + a `delivered` delivery
  with a verified receipt in the trusted session. It creates NO
  PlanCommit/Snapshot, moves NO HEAD, and mutates NO FinalPlan — the final
  HEAD remains the Final PlanCommit forever (§135). `completed` means:
  Final Plan approved + handoff successfully delivered + Ultra Plan no longer
  owns active workflow. It does NOT mean the implementation is finished. A
  completed run is terminal: /ultra-plan starts a NEW run (§49).
- **Build boundary (§51-§56/§107/§108):** Build keeps read-only Plan Memory
  access (FinalPlan, exact refs, contracts, decisions, constraints) and NO
  planning mutation capabilities; the handoff prompt authorizes executing the
  approved plan but does NOT bypass OpenCode sandbox/permissions, does not
  require reconfirmation ("do not ask whether to implement"), and injects no
  raw planning history. Build-discovered design defects are follow-up work
  outside the completed run.
- **Fail closed (§116/§122-§124):** durable load validation refuses a
  handoff whose hash/projection disagrees with the committed FinalPlan, a
  delivery with a fake/mismatched receipt or deliveryKey, or a completed run
  without a confirmed delivered handoff. Runtime incompatibility leaves the
  approved FinalPlan durable and the run resumable at handoff_pending.

## 8. Evidence Promotion Rules

Trust domains stay separate: Plan Memory is approved/authoritative; repository
Evidence is observed/freshness-aware.

```text
OpenCode repository tool → Observation (ledger, per session) → explicit promotion → Evidence
```

- `confidence=direct` — REQUIRES ≥1 `observationIDs` that exist in THIS session's
  observation ledger; the evidence's `source` provenance is built FROM those
  observations. Direct evidence from model text alone is impossible
  (`missing_provenance` / `unknown_reference`).
- `confidence=derived` — REQUIRES `derivedFrom` refs that resolve to existing
  evidence; freshness degrades to `needs_validation` if any upstream is not fresh.
- `confidence=uncertain` — no provenance required, but freshness is forced to
  `needs_validation` (unverified claims can never satisfy the critical-evidence
  freshness gate at finalization).
- Evidence revisions are immutable and monotonic; evidence is NOT committed Plan
  Memory and requires no user approval (spec §25).

## 9. VALIDATION Interpretation (Phase 2A resolution)

The lifecycle diagram (§4.1) shows SYNTHESIS → VALIDATION → FINAL, but the frozen
`PlanningStage` union has no `validation` member. Resolution (smallest
architecture-compatible interpretation):

> **VALIDATION is the deterministic finalization predicate applied as the gate on
> the SYNTHESIS → FINAL transition — not a separately persisted stage.**

```text
synthesis
   ↓ request_synthesis (model may only REQUEST)
Harness runs checkFinalization:
   architecture approved AND all sections approved AND valid
   AND blocking questions == 0 AND blocking conflicts == 0
   AND critical evidence fresh
   ├── failures → finalization_blocked (deterministic failure list; reopen/detail)
   └── clean    → stage = final
```

No new persistent stage was introduced; the frozen stage union is untouched. If live
use proves a persisted validation stage is required, that is an architecture amendment
proposal for human review — not an implementation change.

## 10. Runtime Capability Assumptions

Verified against the installed OpenCode plugin/SDK (see phase-2a-report.md):

- command registration, agent configuration, per-agent model binding, plugin tools,
  tool execution hooks, system-context transform, SDK prompt-level agent/model
  selection: AVAILABLE;
- imperative per-session agent/model switching: NOT AVAILABLE in OpenCode v1.18 —
  planning/execution runtime selection binds per command/agent/prompt. The runtime
  adapter declares this as an explicit negative capability
  (`dynamicModelSwitch=false`, `dynamicAgentSwitch=false`); no speculative APIs exist
  in the adapter.

The L0 Planning Protocol (`src/context/protocol.ts`) is rendered deterministically from
static rules plus the live capability set, and injected into planning-model system
context via `experimental.chat.system.transform` ONLY for sessions with an active run.
