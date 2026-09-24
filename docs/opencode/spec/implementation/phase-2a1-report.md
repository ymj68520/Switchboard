# Phase 2A.1 Implementation Report

**Scope:** Authority-boundary corrections (Corrections A/B/C) and the approval-admission contract freeze.
**Frozen architecture:** unmodified. **Protocol:** updated to **v0.1.1** (`opencode-ultra-plan-agent-protocol.md`).

---

## Authority Issues Corrected

| # | Issue | Correction |
|---|---|---|
| A | `ultraplan_resolve_question` could move a blocking OpenQuestion `open → resolved`, bypassing Proposal → Approval → PlanCommit | Tool replaced by `ultraplan_propose_question_resolution` (Option A of the brief): records only `OpenQuestion.proposedResolution = { text, proposedAt }`; `status` stays `open`; blocking stays blocking. The old tool name is deleted AND listed in `FORBIDDEN_TOOL_NAMES` — no compatibility path exists. |
| B | `ultraplan_start` in the model's tool surface allowed independent planning entry | One-shot, session-scoped, command-specific, TTL-bounded **StartAdmission** issued only by the `command.execute.before` hook (a real OpenCode hook the model cannot invoke) when the user runs `/ultra-plan`; the controller consumes exactly one admission per start. No admission → `start_not_authorized`. |
| C | Proposal approval path under-specified: `ready` proposals were effectively the approval surface, and the hash covered mutable workflow fields | Frozen approval-admission state machine: `ready → awaiting_approval` is a Harness-only, content-frozen transition (`beginProposalApproval` / `PlanStore.transitionProposalStatus` — only `status` may change); structured one-shot `UserApprovalDecision` bound to exact id/revision/hash (`applyApprovalDecision`); canonical approval payload excludes `status` and `hash`, so the admission transition cannot move the hash. Golden hash test pins the contract. |

## Explicit Plan Entry Admission

Implementation: `core/admissions.ts` (`InMemoryStartAdmissionLedger`, TTL
`START_ADMISSION_TTL_MS = 10 min`), wired via:

```text
/ultra-plan command (user)
      ↓ hooks["command.execute.before"]  (src/index.ts — compares against runtime.spec.commandName)
controller.issueStartAdmission(sessionID)          ← Harness-only minting path
      ↓ (command template directs the model)
ultraplan_start(sessionID) → controller.startOrResume
      ↓ admissions.consume(sessionID, "ultra-plan")
create / resume — or UltraPlanError("start_not_authorized")
```

Properties (all tested): session-scoped; command-specific; one-shot (consumed
admission is never reusable); short-lived (TTL, separately tested with an injected
clock); Harness-created only (no tool argument, no prompt text can mint one;
`issueStartAdmission` is not reachable from any model-visible tool); invalid for
other sessions.

**Start vs resume semantics (brief §4, implemented and documented on
`startOrResume`):** no active run → create; active run → resume/report the same
run; completed/aborted → a NEW run requires a fresh explicit command;
`handoff_pending` → resume/report only (never a new run, never re-enters handoff —
recovery stays Harness-authoritative).

**Tool exposure (brief §5):** the `ultraplan` planning agent's config now
explicitly enables the Ultra Plan tool map (`OpenCodeRuntimeAdapter.applyToConfig`),
which narrows exposure. This is explicitly defense-in-depth: OpenCode per-agent
tool maps are overrides rather than allowlists, so the controller's admission check
remains the authorization mechanism, and a direct invocation without admission
fails deterministically. New error code: `start_not_authorized`.

## Question Resolution Boundary

`proposeQuestionResolution` (controller) + `ultraplan_propose_question_resolution`
(tool; capability `propose_question_resolution` in the matrix, same stage grants as
before) record a candidate on the OpenQuestion. Invariant enforced and tested:
before a PlanCommit, `status === "open"` and blocking questions remain blocking;
authoritative `resolution`/`resolvedBy` are only set by a PlanCommit containing
`resolve_question` (Phase 2B applies this; the proposal-intent path already accepts
`resolve_question` changes). `OpenQuestion.proposedResolution` is a documented
working-state extension to the frozen §7 shape.

## Proposal Approval Lifecycle

Frozen in `transaction/approval.ts` + `memory/store.ts` — contract only, no
persistence/commit:

```text
ready  --beginProposalApproval(sessionID, proposalID)-->  awaiting_approval
              (store.transitionProposalStatus: from-status checked,
               ONLY status changes, hash unaffected)
awaiting_approval  --structured UserApprovalDecision-->  applyProposalDecision
              approved → validated Approval record (id/revision/hash/actor=user)
              rejected → validated rejection outcome
```

- `ready` proposals are not approvable (`proposal_not_approvable`).
- Content cannot change at any point (`proposal_immutable` id-freeze;
  `transitionProposalStatus` copies everything but `status`).
- The model has no path to any of this: `beginProposalApproval` /
  `applyProposalDecision` are controller methods not exposed through the tool
  registry, and no tool can construct a valid `UserApprovalDecision` (actor is
  type-pinned to `"user"` and runtime-checked).

## Proposal Hash Contract

`transaction/hash.ts` now defines the canonical payload (`proposalApprovalPayload`):
**included** — id, revision, type, scope, title, summary, changes, dependencies,
impact, createdFrom; **excluded** — `status` (workflow state; changes at
ready → awaiting_approval and approved/rejected) and `hash` itself; the Proposal
type carries no timestamps. Canonicalization: `stableStringify` — object keys
sorted lexicographically, `undefined` dropped, arrays kept in order (change order
is part of the approved content), SHA-256 over the UTF-8 serialization. Consequence:
`ready → awaiting_approval` provably cannot change the approval hash. Golden hash
test: fixed proposal → `3ecb08ae86d98d42391890435590664992d1ede36b491e5918ebefd2922ee140`
with the exact payload key set asserted; any normalization change breaks the test.

## OpenCode Structured Approval Findings

Re-verified from the installed `@opencode-ai/plugin` 1.18.32 / SDK types:

- `ToolContext.ask({ permission, patterns, always, metadata }): Promise<void>` —
  returns **void**: allow resolves, deny is signaled by rejection/abort (no
  structured decision value). The user MAY be offered an "always allow" choice
  (`always: string[]`) — **a persistent permission must never authorize a future
  Proposal approval**, so the frozen gateway contract forbids passing any `always`
  pattern for approval requests; `ApprovalRequest.oneShot: true` and the absence of
  any pattern/persistence field on the request type encode this (tested).
- `metadata` survives into the SDK `Permission` record (`Permission.metadata`), so a
  unique `{ proposalID, proposalRevision, proposalHash }` binding can ride in the
  permission string + metadata — sufficient to bind one TUI confirmation to one
  exact proposal.
- `permission.ask` hook + `permission.replied` event provide the structured reply
  path for a Phase 2B approval UX.
- Phase 2B must therefore build approval on `ask()`/`permission.ask` with: empty
  `always` list, proposal binding in metadata, one-shot consumption, and the
  validated `applyApprovalDecision` boundary. No fake conversational parser exists
  or will be added.

## Completion / Reopen Audit

- `ultraplan_request_completion`: audited — it validates scope and prepares
  `section_completion` proposal intent only. No code path sets an
  Architecture/Section status; tested that nothing completes directly and
  `commitTransaction` remains behind `phase_boundary`.
- `ultraplan_request_reopen`: audited — prepares `amendment` intent only.
  **Decision (documented in protocol §7.3):** the `reopened` Section status is
  committed-artifact state (it changes approved-state semantics), so it may only be
  applied by the PlanCommit carrying the amendment — never by the model. Today a
  reopen request against a not-yet-committed artifact fails deterministically with
  `unknown_reference` and mutates nothing.

## Tests Added

`test/authority-boundary.test.ts` (17 tests) — mapping to the brief's required
list: (1) direct start without admission denied (controller + tool surface),
(2) command creates valid admission, (3) session-scoped, (4) no reuse,
(5) cross-session rejection, (6) command+no-run creates, (7) command+active-run
resumes, (8) terminal run needs a fresh admission / handoff_pending resumes,
(9)+(10) no model path clears a blocking question — candidate keeps `open`/blocking
and the old tool is forbidden+absent, (11) `resolve_question` proposal intent
permitted, (12) ready ≠ approvable, (13) ready → awaiting_approval preserves hash
and content, (14) content immutable while awaiting (id-freeze + status-only
transition), (15) hash mismatch rejected, (16) exact id/revision/hash binding →
validated Approval, (17) no tool authority can mint `actor="user"` (union type +
runtime guard), (18) `ApprovalRequest.oneShot` with no persistence fields,
(19) request_completion never completes, (20) request_reopen only prepares intent.
Plus the golden-hash contract test. Existing Phase 1/2A tests were updated for the
admission gate (helpers simulate the user command) and the capability rename —
65 → 82 tests, all passing, none skipped.

## Live Runtime Validation

**12/12 checks passed** (`npm run smoke:opencode`, real `opencode serve`,
opencode-ai 1.18.31, free gateway model, plugin loaded from built dist). New in
2A.1:

```text
PASS  model-invoked ultraplan_start WITHOUT /ultra-plan is DENIED (start_not_authorized)
      — a plain user prompt asked the real model to call the tool; the tool executed
      and returned ERROR [start_not_authorized]; no PlanningRun was created
PASS  no PlanningRun was created by the denied call
PASS  /ultra-plan creates PlanningRun(discovery) with real sessionID (create path)
      — explicit command → admission → run
PASS  deterministic status block returned — Ultra Plan\n\nPlan: PLAN-001
PASS  second /ultra-plan RESUMES the same run (created=false path)
PASS  no second OpenCode session was created
```

plus the prior infrastructure checks (server up, plugin loads, config hook
registers command + planning agent, all 11 tools exposed — including the renamed
`ultraplan_propose_question_resolution`). Limitation stated precisely: the
unauthorized probe relies on the model choosing to obey "call ultraplan_start"
(the model did); the denial itself is enforced by Harness code regardless of the
model's compliance, and the same denial is proven at unit/integration level
without any model.

## Verification Results

```text
npm run typecheck    → 0 errors
npm run lint         → 0 problems (no `any`, no disabled rules, no skipped tests)
npm test             → 8 files, 82/82 tests passed
npm run build        → dist emitted; live smoke runs against the built output
npm run smoke:opencode → 12/12 live checks passed
```

## Deviations / Remaining Questions

- `OpenQuestion.proposedResolution` extends the frozen §7 shape (working-state
  field; analogous to the 2A `handoff_pending` lifecycle correction — amendment
  candidate for human review).
- The capability/tool rename (`resolve_question` → `propose_question_resolution`)
  changes the 2A matrix; the protocol document is the contract and was bumped to
  v0.1.1 rather than treated as immutable — the frozen architecture file was NOT
  touched.
- Start admissions are in-memory (lost on server restart, like all 2A state);
  durable persistence in 2B must include the admission ledger or accept that a
  restart invalidates pending entries (fail-closed either way).
- Open question for 2B UX: whether approval should surface via `ToolContext.ask`
  inside a Harness tool invocation or via the `permission.ask` hook — both verified;
  the gateway interface (`ApprovalRequest`/`UserApprovalDecision`/
  `applyApprovalDecision`) is UX-agnostic.

## Phase 2B Entry Conditions

All three gates from the brief are satisfied and enforced:

1. `user /ultra-plan → verified one-shot StartAdmission → PlanningRun
   create/resume` — enforced in code, tested, and proven live (12/12).
2. `model proposes question resolution → blocking question remains open →
   Proposal(resolve_question)` — enforced; the authoritative transition exists
   only inside a future PlanCommit.
3. `Proposal ready → Harness → awaiting_approval → exact structured user approval
   (ApprovalID + proposalRevision + proposalHash)` — frozen contract
   (`beginProposalApproval`, `transitionProposalStatus`, `ApprovalRequest`,
   `UserApprovalDecision`, `applyApprovalDecision`, canonical hash + golden test).

Phase 2B can begin with the transaction engine consuming exactly these contracts.
