# Phase 2I Implementation Report

## Implemented

Phase 2I — Formal Final Proposal, Final Approval & Final PlanCommit. Entry
state (the complete Phase 2H exit: current candidate + clean report + passing
audit + `request_synthesis` withheld) extended with the formal
user-authorization boundary:

- `ultraplan_prepare_final_plan` (model-facing, proposal_intent, accepts
  NOTHING — §6): reruns the Finalization Gate, requires the CURRENT candidate,
  freezes the exact `final_plan` Proposal with exactly one `add_final_plan`
  change (§5/§16);
- the immutable committed `FinalPlan` — the exact candidate projection with
  the full derived-artifact provenance chain, Harness-assigned FINAL-###@n,
  `approvedAt` = the exact Approval.createdAt, and the deterministic
  hash-bound body projection (§9-§15);
- the standard Approval protocol reused verbatim (Proposal id/revision/hash,
  actor=user, `ToolContext.ask`, one-shot, `always: []`) with the narrow §22
  synthesis capability and the §57 pre-ask staleness refusal;
- the MANDATORY SECOND FinalizationGate inside the transaction engine with
  exact identity equality (§25-§27) — every post-approval drift scenario
  refuses the commit with zero state change;
- the single atomic Final PlanCommit publishing FinalPlan + run pointer +
  stage synthesis → final + lifecycle active → handoff_pending + Snapshot +
  PlanCommit + approved Proposal + events + HEAD-last (§34/§35);
- durable FinalPlan family with fail-closed load validation and the
  §70-§74 corruption matrices, the §67/§68 process-level crash probes, and
  the §58-§60 concurrency semantics.

NOT implemented (deferred by the brief): runtime Build handoff, execution
model/agent switch, ExecutionHandoff delivery, `lifecycle = completed`,
FinalPlan amendment — all Phase 2J (or later) work. The frozen architecture
spec was NOT modified.

## Final Approval Stage Interpretation

Per brief §3: while a final_plan Proposal exists (ready, awaiting_approval,
even approved-but-uncommitted), the run REMAINS stage=synthesis /
lifecycle=active. The boundary is `Proposal.type = final_plan` +
`Proposal.status`, never a premature stage change — evidence, questions,
conflicts, the manifest, and the report may all move while the user is
considering the Proposal. Only the successful Final PlanCommit performs both
transitions, atomically. Implementation-layer interpretation: the frozen
architecture document is unmodified; the interpretation (and the
candidate-projection/second-gate machinery that makes it safe) is recorded
here and in protocol doc §7.14 as the amendment candidate if the frozen
lifecycle diagram is judged to require stage=final before Approval.

## FinalPlanCandidate → FinalPlan Mapping

ONE shared projection: `finalization/plan.ts buildFinalPlanFromCandidate`
(`finalization/plan.ts:52`). Used at Proposal freeze AND recomputed by the
engine at commit validation (`memory/store.ts` §33 check) — no duplicated
mapping logic exists. Exact copies: architecture ref, exact approved
SectionRevisions (canonical DAG order), exact Decision revisions, committed
constraints, manifest implementationOrder and limitations (§11/§13/§33).
Provenance bound structurally (§12): candidate id/revision/hash, input id/hash,
manifest id/revision/hash, report id/hash/result=clean, audit id/hash/result=
pass, pre-commit HEAD Snapshot ref + commit.

## Final Proposal Contract

- type `final_plan`; scope = the candidate's exact ARCH@n (§17 — no
  "global latest"); revision 1; status ready at freeze; impact empty (§16 —
  the Final approval adds no design).
- The proposal hash (unchanged canonical payload contract) covers the
  complete FinalPlan payload via `changes`; createdFrom binds the base HEAD
  snapshot; §17-§18 mutation tests pin candidate-hash / section-revision /
  implementation-order / audit-identity / base-snapshot / plan-identity
  changes.
- §19 idempotency: prepare over the same current candidate returns the
  existing ready/awaiting Proposal (no duplicates); a rejected Proposal is
  never resurrected — a NEW explicit preparation over the still-current
  candidate is allowed (new Approval required).
- §20/§57: `beginProposalApproval` refuses a stale Final Proposal BEFORE any
  user-facing confirmation (`final_proposal_stale`): it re-verifies the
  candidate binding and reruns the gate, requiring exact identity equality.

## add_final_plan Transaction Change

`ProposalChange` gains `add_final_plan` carrying `finalPlan:
FinalPlanContent` (the frozen payload WITHOUT `approvedAt` — §15's narrow
freeze exception: approvedAt is system transaction metadata stamped from the
Approval at commit). Legal ONLY inside a final_plan proposal, which must
carry exactly one such change (engine: `final_plan_type_invalid` /
`final_plan_change_invalid`). NOT part of the generic
`ultraplan_prepare_proposal` vocabulary (`PREPARED_CHANGE_KINDS` unchanged).

## Final Proposal Hash / Idempotency

Hash: unchanged `computeProposalHash` (changes/scope/createdFrom included,
status excluded) — §18 mutation tests added. Preparation idempotency: §19
(above). Commit idempotency: unchanged engine replay (§59) — an exact
duplicate Proposal+Approval delivery returns the ONE commit; two instances
converge on one Final Proposal (durable refresh-before-allocate + same-
candidate idempotency, §58).

## Formal Approval Flow

`beginProposalApproval` (ready → awaiting, plus the §57 final-proposal
currency gate) → `ToolContext.ask` (registry; `always: []`, one-shot,
structured metadata) → `recordApproval` (immutable Approval persisted; the
Proposal STAYS awaiting_approval — §24 crash-safe semantics) →
`commitApprovedProposal` → `commitTransaction`. Denial → `rejectProposal`
(§23/§54/§83: Proposal rejected, no Approval, run untouched, candidate
preserved, HEAD unchanged). §84: the approval survives a crash before the
commit; no repeat approval is needed while the exact gate identity stays
current (`recordApproval` is binding-idempotent).

## Mandatory Post-Approval Finalization Gate

Inside `executeTransaction` (the single committed-state authority), for
`proposal.type === "final_plan"`, the engine SYNCHRONOUSLY resolves the gate
inputs from its registries (no awaits in the atomic section —
`resolveGateDepsSync` reuses the same pure traversal core extracted from
`finalization/audit.ts`) and calls the SAME pure `evaluateFinalizationGate`
(one finalization authority; §26 holds even when controller checks are
bypassed). Requirement: result = pass AND
`finalizationIdentityMatchesCandidate(gate.identity, candidate)` (§27 — a
generic pass under a different identity never authorizes the old Proposal).
The engine also re-verifies: candidate hash recompute, §33 payload equality,
every exact ref resolution, stage=synthesis, `finalPlan` absent, and no
committed FinalPlan (initial-only, §10). Dedicated failure codes surface as
the top-level error (`finalization_stale` / `finalization_blocked` /
`final_proposal_stale`), not buried in `transaction_validation_failed`.

## Evidence / Blocker Drift After Approval

All §28-§31 scenarios proven against the DIRECT `store.commitTransaction`
path with a durable Approval: evidence revision bump without HEAD movement →
`finalization_stale` (the reachable-evidence fingerprint moved; the engine's
gate falls back to the newest audit so the classification is STALE, not
BLOCKED-missing); new blocking question / blocking conflict →
`finalization_blocked`; new manifest revision → `finalization_stale`; a NEW
current candidate (recovery loop: re-freeze at the same HEAD → new input →
manifest → validation → FPC-001@2) → `final_proposal_stale` (the gate passes
for the NEW identity — §27/§31 exactness). The old Approval is never mutated
(§56) and never applies to the new Proposal (§82's full recovery-and-recommit
flow is pinned).

## Final PlanCommit Semantics

ONE publication (`publishTransaction`): FinalPlan records written,
run header gains `finalPlan` + `stage: final` + `lifecycle:
handoff_pending` (staged — never a post-commit saveRun, §34/§41), the
Snapshot carries `finalPlanRevision` (§42), the PlanCommit records
`add_final_plan FINAL-001@1` with the exact Approval/parent/snapshot (§43),
the Proposal flips to approved only inside the commit, `run.stage_changed`
+ `run.lifecycle_changed` + `artifact.revised kind=final_plan` +
`transaction.committed` + `head.moved` events, HEAD LAST (§35). A committed
FinalPlan is once-per-run: any later final transaction refuses
(`run_not_active` / `final_plan_already_exists`).

## FinalPlan Durable Representation

Additive `finalPlans` doc family (schema stays 1); no `saveFinalPlan` method
exists on the PlanStore boundary — the engine is the only writer (§41).
The committed record: identity (`FINAL-001@1`), status approved, exact refs,
order/limitations, provenance bindings, `approvedAt`, hash-bound `body`
(deterministic projection re-verified on load — §14 decision option 1:
persisted AND hash-bound). Load validation (§70-§74): hash + body recompute,
candidate/input/manifest/report/audit resolution with matching hashes and
clean/pass results, candidate projection equality, exact ref resolution, and
the run-pointer/commit/snapshot triangle (pointer↔record, handoff_pending ⇒
stage final + final HEAD commit + snapshot ref, approved final Proposal ⇒
commit recorded). Fail closed; no repair.

## Stage / Lifecycle Transition

Staged in `executeTransaction` (after all validation, failures=0):
`stage → final`, `lifecycle → handoff_pending`, `activeWork → undefined`;
published with everything else; `run.stage_changed` and
`run.lifecycle_changed` events in the SAME publication (§36/§37). Justified
only because an immutable formally-approved FinalPlan now exists (§36).

## Handoff Pending Boundary

`handoff_pending` = "final planning authorization complete; runtime Build
handoff not yet completed" (§37/§38). No execution model/agent switch, no
ExecutionHandoff, no Build turn, no `completed` (§80 — pinned by tests: no
runtime events, lifecycle unchanged, `getCapabilities` = reads only, §79).
The L0 protocol renders the §86 handoff_pending fragment; status renders
"Build handoff: pending" and NEVER "Build started"/"Run completed" (§85).

## Snapshot / Commit Consistency

The final commit's resulting Snapshot carries `finalPlanRevision` equal to
`PlanningRun.finalPlan.revision` (§42/§71); the commit's proposal is the
approved final_plan Proposal with its exact Approval (§72); durable load
re-proves the triangle and fails closed on any mismatch (§71/§72/§74).

## Capability Matrix

SEVEN synthesis substates (protocol §4 v0.10, pinned by
test/capabilities.test.ts):

- `final-candidate-ready` (2H) gains `prepare_final_plan` (§49);
- NEW `final-proposal-ready` (§50/§51): a CURRENT final_plan Proposal
  (ready/awaiting, binding the current candidate) adds
  `request_user_approval` — narrowly, verified independently at the approval
  boundary; `submit_synthesis_manifest`, Section mutation, unsanctioned
  reopen, and `request_synthesis` stay withheld;
- `handoff_pending`: reads only (unchanged, §52) — no planning mutation, no
  finalization re-run via model tool (§79);
- `request_synthesis` remains granted nowhere (§53).

## Approval View

`renderProposalForApproval` renders the `add_final_plan` change as the §45
FINAL PLAN APPROVAL view: exact FinalPlan ref, base snapshot, ARCH@n,
sections, implementation order, constraints, limitations, validation/audit
identities, candidate ref+hash, the effect block (commit immutable FinalPlan;
stage → final; lifecycle → handoff_pending; "Build handoff will NOT run in
this phase"), and the §46 lines ("Approval authorizes the Final PlanCommit."
/ "Runtime Build handoff occurs only from handoff_pending in the next
workflow."). Pure deterministic projection of the frozen Proposal; pinned by
§75 tests including byte-equality on re-render.

## Restart Recovery

§69/§81: close + reopen the durable store after the Final PlanCommit recovers
byte-identical state — same PlanningRun (handoff_pending, stage final, exact
finalPlan pointer), exact FinalPlan (hash/body recompute), Proposal approved,
Approval, final PlanCommit, HEAD COMMIT-009; the session RESUMES the same run
(`findActiveRunBySession` includes handoff_pending; no new run is created).

## Crash / Concurrency Validation

- §67 (real child process): crash before the final commit's durable
  publication (`process.abort` at the commit seam, exit 134) leaves zero
  Final Plan state — no FinalPlan, stage synthesis, lifecycle active,
  Proposal awaiting_approval, the ONE Approval durable, HEAD COMMIT-008; a
  fresh process/controller's exact retry commits (the gate remains current).
- §68 (real child process): crash after the durable publication but before
  the response recovers the exact handoff_pending state — exactly one
  FinalPlan, run pointer exact, Proposal approved, HEAD COMMIT-009; retry is
  idempotent; no Build handoff occurred.
- §66: in-process publication fault injection (overridden
  `publishTransaction`) — zero partial FinalPlan state, then the exact retry
  commits.
- §58/§59: two independent DurablePlanStore instances on one file — B's
  preparation is refused (reads-only surface) and B's replay of the exact
  committed transaction returns A's commit (one Final PlanCommit, one
  FinalPlan, one HEAD move). §60: the competing stale Final Proposal loses
  (`final_proposal_stale` pre-winner, `run_not_active` post-winner).

## Corruption / Fail-closed Tests

§73: tampered payload with resealed hash AND re-derived body (sophisticated
attacker) still fails the candidate-projection check ("implementationOrder
differs from its bound candidate"); hand-edited body (hash resealed) fails
the body-projection check; plainly tampered approvedAt fails the hash
recompute; a blocked-audit binding fails the provenance check. §71/§74:
missing FinalPlan under a set pointer; handoff_pending whose HEAD is not the
approved final transaction; approved final Proposal without its commit. All
`store_corrupt` at open; no repair.

## Tests Added

- `test/final-plan.test.ts` (43 tests): preparation (§5-§10/§19 incl. denial
  and no-smuggling), payload/hash mutation (§9-§18/§33), approval boundary
  (§20-§24/§57/§83), mandatory second gate + drift (§25-§31 direct-engine),
  commit effects (§34-§44/§81), handoff-pending boundary (§37/§38/§52/§79/
  §80), reads (§47), view + status (§45/§46/§75/§85), durable restart +
  §58/§59 two-instance + §70-§74 corruption.
- `test/durable-crash.test.ts` (+2): §67 pre-persist and §68 post-persist
  process-level crash recovery for the Final PlanCommit.
- `test/capabilities.test.ts` (+1 substate column), `test/finalization.test.ts`
  (§58 L0 pins extended with the Phase 2I final-boundary fragments),
  `test/section-completion.test.ts` (test 60 L0 pins extended).

Full OpenCode suite: 497 tests / 20 files, all green (452 pre-2I + 45 new).

## Live OpenCode Validation

`scripts/opencode-live-smoke.mjs` extended honestly (§90):

- PASS: `ultraplan_prepare_final_plan` is registered on the real server
  (tool-ids endpoint);
- PASS: it refuses with structured `capability_not_available` outside the
  candidate-ready synthesis substate (live probe from the architecture stage
  of a real session);
- HONEST SPLIT (stated exactly): the complete Proposal → ToolContext.ask →
  Approval → second-gate → Final PlanCommit chain is NOT traversed live —
  headless smoke cannot produce a genuine user Allow, and faking one would
  violate the no-fake-approval rule. That chain is deterministic
  integration-tested (test/final-plan.test.ts + the §67/§68 crash probes).
  That `ultraplan_request_user_approval` is granted ONLY in the
  final-proposal synthesis substate is pinned by the capability matrix tests,
  not by this headless run.

## Verification Results

True producer exit codes, `adapters/opencode` workspace:

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck -w @switchboard/opencode` | exit 0 |
| Lint | `npm run lint -w @switchboard/opencode` | exit 0 |
| Tests | `npm test -w @switchboard/opencode` | exit 0 — 497 passed / 497 (20 files) |
| Build | `npm run build -w @switchboard/opencode` | exit 0 |
| Live smoke | `npm run smoke:opencode` | 35/35 checks, exit 0 |

Root aggregate (true producer exit codes, from the repo root):

- FIRST RUN: `npm run typecheck` → exit 2; `npm run lint` → exit 1;
  `npm test` → exit 1; `npm run build` → exit 0.
- RETRY: identical (deterministic, not a flake).
- EXACT FAILING WORKSPACE: `adapters/claude-code` ONLY — all three failures
  live in that workspace's OWN in-flight observation/evidence foundation
  (files created/modified by the concurrent workstream during this session,
  none by this phase): typecheck error in its untracked
  `src/observations/capture.ts` (CaptureOutcome assignment, 1 error); lint
  unused-var in its untracked `src/application/evidence-service.ts`
  (`insertEvidenceArtifactInTx`, 1 error); tests 30 failed / 420 passed /
  1 skipped across 11 of its own store/migration/MCP suites — deterministic
  on retry. In the SAME root runs the OpenCode workspace was green:
  **497/497 tests passed (19 files)**, and `@switchboard/codex` passed
  125/125.
- Per the standing constraint, `adapters/claude-code` was NOT touched to
  make root green; its failures are reported here separately. The frozen
  architecture spec (`docs/opencode/spec/opencode-ultra-plan-architecture.md`)
  has zero diffs (`git diff --stat` empty).

## Deviations From Frozen Architecture

None requiring an amendment candidate beyond the one recorded above: the
synthesis-during-Final-Approval stage interpretation (§3) is an
implementation-layer choice — the frozen spec's lifecycle diagram is
unmodified, and if it is judged to require stage=final before Approval, that
is the recorded amendment candidate (protocol §7.14). Additional
implementation-layer decisions documented: `add_final_plan` carries the
payload without `approvedAt` (commit-stamped from the Approval, §15);
`FinalPlan.status` is committed-"approved" only — no awaiting_approval
FinalPlan object exists (the immutable Proposal represents the pending plan,
§39); the body IS persisted but hash-bound and re-verified against the
deterministic renderer (§14 option 1); the engine's second gate reuses the
newest audit as fallback so a drifted world classifies STALE rather than
BLOCKED-missing (§28's classification, refusal either way).

## Risks / Open Issues

- The final-proposal currency context for `request_user_approval` is derived
  per-request (candidate binding + gate identity). A user sitting on an
  awaiting approval dialog while the world drifts is still safe: the engine's
  second gate refuses the commit — but the UX surface (dialog already shown)
  will report the refusal after Allow rather than before. The pre-ask §57
  check covers the common path.
- `FinalPlan` amendment/reopen after handoff authorization is deliberately
  unimplemented (§10); a future amendment phase must extend the load
  validation's "initial-only family" invariant.
- Phase 2J must treat the runtime handoff as a recoverable side-effect
  boundary separate from Final Plan correctness (§92); nothing in this phase
  emits handoff events or touches the runtime switch.

## Phase 2J Entry Conditions

```text
PlanningRun.lifecycle = handoff_pending
PlanningRun.stage = final
PlanningRun.finalPlan = FINAL-001@1 (immutable, approved, hash-bound)
final_plan Proposal = approved; Approval durable; Final PlanCommit = HEAD
Snapshot carries finalPlanRevision; durable load re-proves the full triangle
No ExecutionHandoff exists; no execution model/agent switch has occurred;
lifecycle = completed is NOT set
```

Phase 2J owns: handoff_pending recovery, deterministic ExecutionHandoff
rendering, execution-model policy, the same-session planning → Build switch,
handoff delivery confirmation, and `PlanningRun.lifecycle = completed`.
