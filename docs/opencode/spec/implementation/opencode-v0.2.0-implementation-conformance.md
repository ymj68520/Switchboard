# OpenCode v0.2.0 Implementation Conformance Record

**NON-NORMATIVE IMPLEMENTATION CONFORMANCE RECORD**

Architecture authority remains: **v0.2.0 supervised-execution Architecture Specification** (`docs/SPEC/claude-code-phase-plan-v0.2.0-architecture-spec.md`, provider-neutral) together with the frozen OpenCode planning baseline (`docs/opencode/spec/opencode-ultra-plan-architecture.md`). This record was produced by the Phase 8 release-closure audit (Phase 8 §17–§27). It maps every §52 Core Invariant to its implementation location and enforcing test, and records the Phase 8 authority-bypass audits (§20–§27). It does NOT modify any normative semantics; where the wording below paraphrases the SPEC, the SPEC text wins.

Adapter scope: `adapters/opencode/` (Ultra Plan product identity, entry point `/ultra-plan`).

Verification status at freeze: deterministic suites 1005/1005 PASS (0 skipped), typecheck PASS, lint PASS, live-host E73 evidence in `adapters/opencode/smoke/e73-evidence.json`.

---

## 1. Plan / Execution boundary (§52.1–§52.7)

| # | Invariant (paraphrase) | Implementation location | Enforcing test | Verdict |
|---|---|---|---|---|
| 1 | Execution is not a PlanningRun stage | `PlanningRun.stage` union ends at `final` (`src/core/types.ts`); execution objects live in `src/core/execution-*.ts` with separate store families | `test/planning-run.test.ts`, `test/execution-run.test.ts` | PASS |
| 2 | PlanningRun and ExecutionRun are separate durable lifecycle objects | `PlanningRun` (`src/core/types.ts`) vs `ExecutionRun` (`src/core/execution-run.ts`); distinct store families (`src/memory/store.ts` `runs` / `executionRuns`) | `test/execution-run.test.ts`, `test/handoff.test.ts` | PASS |
| 3 | FinalPlan is the normative planning↔execution bridge | `prepareInitialExecutionRun` requires the approved FinalPlan record + hash (`src/memory/store.ts`, §14/§31 checks) | `test/execution-run.test.ts`, `test/final-plan.test.ts` | PASS |
| 4 | Each ExecutionRun permanently binds one exact FinalPlan revision | `ExecutionRun.finalPlan` + `finalPlanHash` set at creation only; Supervisor turn re-resolves binding each turn (`final_plan_binding_mismatch` guard, `src/runtime/opencode-supervisor-adapter.ts`) | `test/execution-run.test.ts` | PASS |
| 5 | An ExecutionRun never rebinds in place | No write path mutates `ExecutionRun.finalPlan` after creation (Phase 8 §22 audit, below); replan creates a NEW run (`test/execution-replan.test.ts`) | `test/execution-replan.test.ts`, source audit §22 | PASS |
| 6 | Completed PlanningRuns are never reactivated | `startOrResumePlanning`/`createPlanningRun` lifecycle guards (`src/core/controller.ts`); replan creates a NEW PlanningRun | `test/planning-run.test.ts`, `test/execution-replan.test.ts` | PASS |
| 7 | Final Approval authorizes supervised execution without bypassing host permissions | Atomic supervised marker + capability ceiling intersection `assertEnvelopeWithinHostCeiling` (`src/runtime/capability-projection.ts`); `trustedCeiling` derived from REAL host config (`deriveHostPermissionCeiling`) | `test/execution-production-handoff.test.ts`, `test/capabilities.test.ts` | PASS |

## 2. Execution authority (§52.8–§52.13)

| # | Invariant | Implementation location | Enforcing test | Verdict |
|---|---|---|---|---|
| 8 | Host owns execution mechanics; harness owns protocol truth | OpenCode owns sessions/models/tools (runtime adapters wrap them: `src/runtime/opencode-supervisor-adapter.ts`, `opencode-worker-adapter.ts`); Store owns transitions (`src/memory/store.ts`) | `test/execution-runtime-adapters.test.ts`, `test/protocol-boundary.test.ts` | PASS |
| 9 | Supervisor reasons/directs; Workers act; Core transitions authoritatively | Supervisor = read/judge + assessment; Worker = Directive execution; every acceptance/progress transition inside Store transactions | `test/execution-supervisor.test.ts`, `test/execution-acceptance.test.ts` | PASS |
| 10 | Supervisor has no normal direct repository/runtime tool authority | `projectSupervisorToolMap` denies the ENTIRE discovered host inventory (Phase 8 §12/§13: `discoverHostToolNames` over `client.tool.ids()`; fail-closed bundle construction); supervisor operations travel the strict JSON contract, not host tools | `test/host-tool-inventory.test.ts`, `test/execution-runtime-adapters.test.ts`; live E74 evidence | PASS |
| 11 | Executor and Verifier are roles of one ExecutionWorker abstraction | One `OpenCodeWorkerAdapter` + durable `ExecutionAttempt.workerRole` (`src/core/execution-attempt.ts`); role is store-supplied, never model-claimed | `test/execution-worker-protocol.test.ts` | PASS |
| 12 | Reports are trusted factual inputs but never advance authoritative state | `submitExecutionReport` records facts only; accepted progress requires assessment+commit transactions | `test/execution-acceptance.test.ts`, `test/execution-worker-protocol.test.ts` | PASS |
| 13 | ExecutionObservation is not part of v0.2.0 | No `ExecutionObservation` type/vocabulary exists (Phase 8 §20/§97 source audit) | source audit (§20 below) | PASS |

## 3. Directive semantics (§52.14–§52.20)

| # | Invariant | Implementation location | Enforcing test | Verdict |
|---|---|---|---|---|
| 14 | Issued Directive revisions are immutable | `ExecutionDirective` PK (directiveID, revision) append-only; no update path (`src/core/execution-directive.ts`, `src/memory/store.ts` `issueExecutionDirective`) | `test/execution-worker-protocol.test.ts`, `test/execution-acceptance.test.ts` | PASS |
| 15 | Directive authority < FinalPlan authority | Directive refs resolve strictly against the bound FinalPlan (`validateExecutionPlanRefs`); normative gaps → `request_replan` | `test/execution-replan.test.ts` | PASS |
| 16 | Directive mutation requires a new revision | Supersede-and-reissue only; original revisions immutable | `test/execution-worker-protocol.test.ts` | PASS |
| 17 | One Directive revision ↔ one logical Attempt | `executionAttemptByDirective` index enforces 1 attempt per revision (1 running per run) | `test/execution-worker-protocol.test.ts`, `test/execution-production-handoff.test.ts` (idempotency) | PASS |
| 18 | Mid-attempt semantic mutation forbidden | Directives immutable; Worker context carries the exact consumed revision/hash | `test/execution-worker-protocol.test.ts` | PASS |
| 19 | A Directive is a logical transaction, not filesystem ACID | Documented in directive semantics; candidate state tracked by VerificationWindow, not fs snapshots | `test/execution-stage-window.test.ts` | PASS |
| 20 | Worker side effects do not imply accepted progress | `candidateMutation` is declarative; acceptance only via SupervisorAssessment → ExecutionCommit | `test/execution-acceptance.test.ts` | PASS |

## 4. Worker freedom and boundaries (§52.21–§52.26)

| # | Invariant | Implementation location | Enforcing test | Verdict |
|---|---|---|---|---|
| 21 | Workers may do repository discovery + semantic-preserving correction | Worker prompt (`executionWorkerSystemPrompt`) + `deviations` channel; tool projection grants read/write per envelope | `test/execution-worker-protocol.test.ts`; live E75/E77 evidence | PASS |
| 22 | Supervisor path expectations are guidance, not permissions | Effective capability envelope (not directive paths) drives the per-call tool map | `test/execution-runtime-adapters.test.ts` | PASS |
| 23 | Workers choose non-normative local details | Worker prompt allows semantic-preserving correction; deviations recorded | `test/execution-worker-protocol.test.ts`; live E77 | PASS |
| 24 | Workers may not fill normative/design gaps | Normative gaps → `blocked` with blockers (report contract; `blocked` requires ≥1 blocker) | `test/execution-worker-protocol.test.ts` | PASS |
| 25 | Missing normative context → blocked, never silent completion | Same report contract; orchestrator maps blocked → directive rework paths | `test/execution-runtime-orchestrator.test.ts` | PASS |
| 26 | Workers receive exact Directive-scoped Plan context, not unrestricted Plan Memory | `ExecutionWorkerContext.resolvedPlanRefs` resolved exactly from directive planRefs (`src/worker/execution-worker.ts`) | `test/execution-worker-protocol.test.ts` | PASS |

## 5. Verification (§52.27–§52.36)

| # | Invariant | Implementation location | Enforcing test | Verdict |
|---|---|---|---|---|
| 27 | No verifier after every implementation directive | Verification insertion policy — verifier dispatch only at verification Directives / windows | `test/execution-stage-window.test.ts`, `test/execution-production-e2e.test.ts` (§72 rework: no automatic verifier) | PASS |
| 28 | Verification organized around VerificationWindows + acceptance boundaries | `openVerificationWindow` / window-scoped assessment (`src/core/verification-window.ts`) | `test/execution-stage-window.test.ts` | PASS |
| 29 | Executor self-check ≠ independent verification | Verifier = fresh child session, `workerRole: "verifier"`; live E76 evidence (fresh session lineage) | `test/execution-worker-protocol.test.ts` | PASS |
| 30 | Every ExecutionCommit requires fresh independent verification of the exact candidate | Acceptance gate binds verifier-covered obligations at the exact candidateRevision (`submitSupervisorAssessment` → commit) | `test/execution-acceptance.test.ts`, `test/execution-completion.test.ts` | PASS |
| 31 | Candidate mutation invalidates verification bound to older candidates | Window candidateRevision CAS; stale assessments refused (`replan/assessment stale` codes) | `test/execution-stage-window.test.ts`, `test/execution-acceptance.test.ts` | PASS |
| 32 | Verifier uses fresh inference context; never inherits Executor reasoning | New child session per invocation (`session.create`), verifier system prompt; no conversation reuse | `test/execution-runtime-adapters.test.ts`; live E76 | PASS |
| 33 | Verifier never silently repairs defects | Verifier prompt forbids repair; `non_mutating` candidateEffect enforced by tool projection | `test/execution-worker-protocol.test.ts`; live E75/E76 | PASS |
| 34 | Negative/contradictory reports block ExecutionCommit until resolved | Acceptance gate refuses with unresolved negative reports (`verification_blocked` family); conflict protocol (Phase 6A E8) | `test/execution-acceptance.test.ts`, `test/execution-conflict.test.ts` | PASS |
| 35 | Model majority voting is not factual authority | One blinded conflict resolver; `supports_a/supports_b` neutralization rules are Core-owned, not vote-counting | `test/execution-conflict.test.ts` | PASS |
| 36 | Conflict-resolution verifier recursion bounded | Resolver recursion depth bounded in the orchestration policy (Phase 6A E8) | `test/execution-conflict.test.ts` | PASS |

## 6. Supervisor derivation / replanning (§52.37–§52.45)

| # | Invariant | Implementation location | Enforcing test | Verdict |
|---|---|---|---|---|
| 37 | Supervisor = JIT compiler from approved normative state to instructions | Deterministic compact context from Store + exact read-only plan refs (`src/core/execution-supervisor-context.ts`) | `test/execution-supervisor.test.ts` | PASS |
| 38 | Supervisor derives consequences; never creates normative facts | Directive planRefs must resolve against the approved FinalPlan; `request_replan` for gaps | `test/execution-replan.test.ts` | PASS |
| 39 | Supervisor may choose normatively equivalent realizations | Stage decomposition + Directive authoring freedom inside planRefs | `test/execution-supervisor.test.ts`; live E73 decomposition evidence | PASS |
| 40 | Multiple materially different normative projections → replanning | `request_replan` assessment → atomic `replan_required` transition | `test/execution-replan.test.ts` | PASS |
| 41 | Best practice/model preference ≠ unapproved normative choice | Same gate: normative choices only through planning | `test/execution-replan.test.ts` | PASS |
| 42 | Repository reality narrows options; never rewrites FinalPlan authority | FinalPlan immutable per run; repository facts enter as evidence in Reports only | `test/execution-replan.test.ts` | PASS |
| 43 | `replan_required` is terminal for the run | Lifecycle graph: `replan_required` has no outbound transition except recovery reads (`src/core/execution-run.ts`) | `test/execution-replan.test.ts` | PASS |
| 44 | Replanning creates a new PlanningRun, later a new ExecutionRun | `createReplanRun` (new PlanningRun with `replanProvenance`); new Final Approval → new ExecutionRun; old run never rebound | `test/execution-replan.test.ts`, `test/execution-production-handoff.test.ts` (§42-§47 routes) | PASS |
| 45 | `replan_required` transition atomically records an ExecutionIssue | Single transaction writes issue + lifecycle (`issueByExecutionRun`) | `test/execution-replan.test.ts`, `test/execution-completion.test.ts` | PASS |

## 7. Execution progress (§52.46–§52.52)

| # | Invariant | Implementation location | Enforcing test | Verdict |
|---|---|---|---|---|
| 46 | ExecutionCommit is the only acceptedHead advancer | `acceptedHead` written only inside the commit transaction (Phase 8 §23 audit) | `test/execution-acceptance.test.ts`; source audit §23 | PASS |
| 47 | Commit chain is linear | Each commit's `parentAcceptedState` = previous commit / execution_start | `test/execution-acceptance.test.ts`; live E73 chain evidence | PASS |
| 48 | A VerificationWindow spans the unaccepted gap between commits | Window opens from `baseAcceptedState`; closes at commit | `test/execution-stage-window.test.ts` | PASS |
| 49 | Window candidateRevision is monotonic | CAS `+1` only; never decremented | `test/execution-stage-window.test.ts` | PASS |
| 50 | Stage completion is Core-derived from accepted progress | Stage completion inside the acceptance transaction (never a raw setter) | `test/execution-stage-window.test.ts`; source audit §21 | PASS |
| 51 | ExecutionRun completion requires the final closure gate | `completeExecutionRunThroughGate` — the only active→completed path (Phase 8 §24 audit) | `test/execution-completion.test.ts` | PASS |
| 52 | Mutable workspace state may differ from accepted state | `acceptedHead` vs workspace baselines are distinct records; abort/rollback semantics documented | `test/execution-completion.test.ts` | PASS |

## 8. Concurrency / recovery (§52.53–§52.64)

| # | Invariant | Implementation location | Enforcing test | Verdict |
|---|---|---|---|---|
| 53 | ≤1 active Stage per run | Partial unique index over active stages (Phase E3) | `test/execution-stage-window.test.ts` | PASS |
| 54 | ≤1 open VerificationWindow per run | Partial unique index over open windows (Phase E3) | `test/execution-stage-window.test.ts` | PASS |
| 55 | ≤1 active logical Attempt per run | Attempt uniqueness per run/window (Phase E4) | `test/execution-worker-protocol.test.ts` | PASS |
| 56 | One active run has ≤1 writable Supervisor session owner | SupervisorBinding single-record family with owner fencing | `test/execution-supervisor.test.ts` | PASS |
| 57 | Ownership uses generation/fencing semantics | `generation` monotonic; stale-generation turns refused (`stale_supervisor_binding`); takeover +1 only | `test/execution-supervisor.test.ts`, `test/execution-production-e2e.test.ts` (§78) | PASS |
| 58 | Worker invocations own no long-lived run bindings | Workers are per-invocation child sessions; no binding writes | `test/execution-runtime-adapters.test.ts` | PASS |
| 59 | Session close/crash/compaction never rewrites durable history | Append-only durable document + event log; recovery is read-only projection | `test/durable-crash.test.ts`, `test/durable-restart.test.ts` | PASS |
| 60 | Side-effecting interrupted Attempts → indeterminate; never blindly replayed | `markExecutionAttemptIndeterminate` + reconciliation gate for `may_mutate`; fresh Directive allowed for `non_mutating` | `test/execution-indeterminate-scope.test.ts`, `test/execution-reconciliation.test.ts` | PASS |
| 61 | Report persistence precedes successful Attempt acknowledgement | Store writes report + attempt state in one transaction before returning | `test/execution-worker-protocol.test.ts` | PASS |
| 62 | Recovery reconstructed from canonical Execution Memory, not conversation | `buildExecutionRecoveryContext` reads only Store records | `test/execution-supervisor.test.ts`, `test/execution-production-handoff.test.ts` (H5 fresh-process derivation) | PASS |
| 63 | Abort is explicit human-authorized; no implied rollback | Host-parsed typed abort authorization (`user-command-authorizations.ts`); exact-run targeting; indeterminate marking; no workspace mutation | `test/execution-production-handoff.test.ts` (§35-§37, §41) | PASS |
| 64 | ExecutionRun binds stable WorkspaceIdentity; no auto-migration | `workspace.key` binding checked on every authoritative call (`workspace_mismatch`) | `test/execution-supervisor.test.ts`, `test/execution-run.test.ts` | PASS |

---

## 9. Frozen state machines — no extra vocabulary (Phase 8 §20)

Source audit of every frozen vocabulary against its declaring constant (all closed unions, none extended):

- `EXECUTION_LIFECYCLES` (`src/core/execution-run.ts:38`): prepared/active/replan_required/completed/aborted — matches SPEC §11.
- `EXECUTION_STAGE_STATUSES` (`src/core/execution-stage.ts:44`) and `StageKind` (ordinary/final_closure) — matches SPEC §13.
- `VERIFICATION_WINDOW_STATES` (`src/core/verification-window.ts:30`) — matches SPEC §14.
- `EXECUTION_ATTEMPT_STATES` (`src/core/execution-attempt.ts:49`) — matches SPEC §17.
- `ExecutionReportResult` (`completed/partial/blocked/failed`) and `CandidateMutation` (`none/changed`) — matches SPEC §18.
- `ASSESSMENT_DISPOSITIONS` / `ASSESSMENT_ACCEPTANCE_SCOPES` (`src/core/supervisor-assessment.ts`) — matches SPEC §39.
- No `ExecutionObservation`, no parallel-execution, no additional lifecycle/status values anywhere in `src/` (grep-audited).

**Verdict: PASS (E25).**

## 10. Authority-bypass audits (Phase 8 §21–§27)

- **Raw setters (§21/E26–E29):** no `setAcceptedHead` / `setCandidateRevision` / `setActiveStage` / `setOpenWindow` / `forceComplete` / `forceReopen`-style production APIs exist. Candidate/accepted/active mutations occur only inside Store transactions (`openVerificationWindow` CAS, `submitSupervisorAssessment` acceptance path, `completeExecutionRunThroughGate`). Test helpers drive the same public Store APIs (no exported bypass).
- **FinalPlan rebinding (§22/E31):** the only writer of `ExecutionRun.finalPlan` is `prepareInitialExecutionRun`; grep shows no other assignment site. REPLAN creates a new run.
- **acceptedHead (§23/E32):** `run.acceptedHead` is assigned only in the ExecutionCommit transaction; the CompletionGate copies (`acceptedHead` at completion is a copy, never rewritten).
- **Completion (§24/E33):** production `active → completed` only via `completeExecutionRunThroughGate` (the ExecutionCompletionGate). Legacy fixture/load compatibility paths do not mutate production state.
- **REPLAN (§25/E34):** `active → replan_required` only via the ExecutionIssue atomic transaction (`execution_transition_replan` → store gate); no bare primitive exists.
- **Abort (§26/E35):** abort requires a host-minted typed authorization (parsed from the RAW user command by the host hook); Supervisor/Worker tool tables contain no abort. Relay without host authorization → `start_not_authorized`.
- **Takeover (§27/E36):** takeover consumes a host-minted typed authorization; models cannot construct one; generation +1 enforced by the store.

**Verdict: PASS (E26–E36).**

## 11. Deviations

None. All semantic-preserving implementation mappings (host-tool inventory discovery via `client.tool.ids()`, deferred plugin bundle attach, thin plugin entry module, additive-family defaults for absent `handoffProtocol`/`Stage.kind`/`verificationPurpose`/`completionRecord`) preserve the frozen semantics and are documented in the implementation docs.
