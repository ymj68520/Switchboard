# Ultra Plan Agent Protocol — v0.2 (Phase 2A + 2A.1 + 2B1)

**Status:** Frozen v0.1 contract as corrected by the Phase 2A.1
authority-boundary freeze and extended by the Phase 2B1 transaction engine
(approval-request presentation capability + approval/commit semantics). The
frozen architecture itself is unchanged; this document is the
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
- prepare proposal candidates (`ultraplan_prepare_proposal`);
- request artifact completion (`ultraplan_request_completion`);
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
- directly advance authoritative state (no stage forcing; transitions happen only
  through validated Harness operations such as the synthesis gate);
- bypass dependency checks (completion requests validate dependency approval);
- bypass evidence freshness gates (finalization validates critical evidence);
- create Evidence without provenance (direct evidence requires real observations);
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

| Tool | Authority | Capability gate | Requires active run | mutatesCommittedMemory |
|---|---|---|---|---|
| `ultraplan_start` | working_state | `start_or_resume` | no — but REQUIRES a one-shot `/ultra-plan` command admission (Correction B) | false |
| `ultraplan_status` | read | `read_status` | no (reports absence) | false |
| `plan_memory` | read | `read_memory` | no (works on any lifecycle) | false |
| `ultraplan_record_question` | working_state | `record_question` | yes | false |
| `ultraplan_propose_question_resolution` | working_state | `propose_question_resolution` | yes | false |
| `ultraplan_raise_conflict` | working_state | `raise_conflict` | yes | false |
| `ultraplan_promote_evidence` | repository_evidence | `promote_evidence` | yes | false |
| `ultraplan_prepare_proposal` | proposal_intent | `prepare_proposal` | yes | false |
| `ultraplan_request_user_approval` | proposal_intent | `request_user_approval` | yes | false |
| `ultraplan_request_completion` | proposal_intent | `request_completion` | yes | false |
| `ultraplan_request_reopen` | proposal_intent | `request_reopen` | yes | false |
| `ultraplan_request_synthesis` | proposal_intent | `request_synthesis` | yes | false |

`allowedStages`/`allowedLifecycle` in code are DERIVED from `getCapabilities`, so the
registry cannot drift from enforcement. The matrix below is the human-readable form of
the same truth and is pinned by `test/capabilities.test.ts`.

---

## 4. State → Capability Matrix (v0.1)

Stage and lifecycle are separate axes and are never collapsed.

| Capability | no run | discovery | architecture | detail | synthesis | final | handoff_pending | completed/aborted |
|---|---|---|---|---|---|---|---|---|
| start_or_resume | ✓ | ✓¹ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓² |
| read_status | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| read_memory | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| record_question | — | ✓ | ✓ | ✓ | ✓ | — | — | — |
| propose_question_resolution | — | ✓ | ✓ | ✓ | ✓ | — | — | — |
| raise_conflict | — | — | ✓ | ✓ | ✓ | — | — | — |
| promote_evidence | — | ✓ | ✓ | ✓ | — | — | — | — |
| prepare_proposal | — | — | ✓ | ✓ | — | — | — | — |
| request_user_approval | — | — | ✓ | ✓ | — | — | — | — |
| request_completion | — | — | — | ✓ | — | — | — | — |
| request_reopen | — | — | — | ✓ | ✓ | — | — | — |
| request_synthesis | — | — | — | — | ✓ | — | — | — |

¹ With an active run present, `ultraplan_start` RESUMES it (never creates a second).
² Creates a NEW run (completed/aborted runs are terminal).

Rationale highlights:

- discovery has no conflicts/proposals: no design exists yet to conflict about;
- synthesis is read-only over approved memory plus blocker-raising; new evidence
  belongs in a DETAIL cycle (raise conflict → reopen → amend with evidence);
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
`finalization_blocked`, `dependency_incomplete`, `phase_boundary`, plus the Phase 1
domain codes and the Phase 2A.1 codes: `start_not_authorized`,
`proposal_not_approvable`, `proposal_status_invalid`, `approval_mismatch`.

`plan_memory` read semantics (spec §20):

- `kind=architecture` — latest committed architecture, or EXACT revision when given;
- `kind=section` — committed Section node, or exact SectionRevision when `revision` given;
- `kind=decision` — exact revision REQUIRED (approved decisions are immutable);
- `kind=evidence|question|conflict|proposal` — resolved from run/evidence state;
- `dependenciesOf=<SEC-…>` — the section plus its dependency contracts;
- an explicit historical revision that does not exist is an `unknown_reference`
  error — it is NEVER silently resolved to HEAD/latest.

## 6. Proposal Authority Boundary

The model may PREPARE proposal candidates; the Harness does everything authoritative:

- Harness assigns `ProposalID` (model never names authoritative objects);
- Harness binds the proposal to the active run, validates scope against run state,
  and binds `createdFrom` to the current HEAD snapshot;
- the change vocabulary at this boundary is CLOSED:
  `add_decision, amend_decision, amend_section, raise_question, resolve_question,
  complete_architecture, complete_section` — other kinds are rejected with
  `proposal_kind_unsupported` until the Phase 2B transaction engine freezes them;
- `final_plan` proposals are NOT tool-creatable (synthesis workflow owns them);
- proposals are created directly in `status="ready"` and are content-frozen: the
  Harness computes a canonical SHA-256 hash; the proposal is immutable from creation
  (`proposal_immutable` on any reuse) — v0.1 has no draft-editing workflow, so the
  spec's "frozen at awaiting_approval" boundary is entered early by construction;
- stage/type legality is enforced (`proposal_type_invalid`): `architecture_completion`
  only in architecture; `section_completion` only in detail; `design_checkpoint` in
  architecture/detail; `amendment` in architecture/detail.

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

- `ultraplan_request_completion` validates readiness and prepares a
  `section_completion` proposal intent. It never marks an Architecture or Section
  approved/complete — completion is applied only by a PlanCommit.
- `ultraplan_request_reopen` prepares an `amendment` proposal intent. The
  `reopened` Section status is COMMITTED-artifact state (changing it modifies
  approved-state semantics), so the model can never apply it directly; it is
  applied by the PlanCommit carrying the amendment. Reopen targets must resolve
  against exact references.

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
