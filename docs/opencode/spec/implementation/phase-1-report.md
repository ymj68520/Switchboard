# Phase 1 Implementation Report

**Scope:** Ultra Plan planning harness for OpenCode — Phase 1 foundation only.
**Workspace:** Switchboard monorepo (`adapters/opencode/`).
**Spec baseline:** `docs/opencode/spec/opencode-ultra-plan-architecture.md` (frozen, unmodified).

---

## Implemented

Phase 1 establishes the verified foundation inside the Switchboard monorepo, as the
OpenCode adapter package `@switchboard/opencode`:

```text
adapters/opencode/
├── package.json / tsconfig.json / tsconfig.build.json / vitest.config.ts / eslint.config.js
├── src/
│   ├── index.ts                     Plugin entry: createUltraPlanHooks() + UltraPlanPlugin
│   ├── core/
│   │   ├── ids.ts                   Branded IDs (PlanID … ContextTraceID) + ID factories
│   │   ├── refs.ts                  Refs with exact revisions, MemoryRef, WorkRef, Timestamp
│   │   ├── types.ts                 PlanningRun, Constraint, Decision, Architecture, Section,
│   │   │                            SectionRevision, SectionContract, OpenQuestion, Conflict
│   │   ├── errors.ts                UltraPlanError with machine-readable codes
│   │   ├── state-machine.ts         Frozen stage + lifecycle transition tables & transitions
│   │   ├── invariants.ts            DAG acyclicity, completion rules, needs_review propagation,
│   │   │                            revision monotonicity, finalization predicate, commit-gated
│   │   │                            run-field guard
│   │   └── controller.ts            UltraPlanController: startOrResume / statusOf
│   ├── transaction/types.ts         Proposal, ProposalChange, Approval, PlanCommit (shapes only)
│   ├── memory/
│   │   ├── events.ts                PlanEvent log types
│   │   ├── snapshots.ts             Snapshot + SnapshotState types
│   │   ├── store.ts                 PlanStore boundary + InMemoryPlanStore
│   │   └── renderer.ts              Deterministic status rendering (renderStatus)
│   ├── context/trace.ts             ContextTrace types (shape only)
│   ├── repository/
│   │   ├── evidence.ts              Evidence, EvidenceSource, EvidenceScope, RepositoryRevision
│   │   └── observations.ts          Observation + ObservationLedger interface
│   ├── runtime/
│   │   ├── types.ts                 UltraPlanRuntime boundary + capability declarations
│   │   ├── opencode-plugin.ts       OpenCodeRuntimeAdapter bound to real plugin APIs
│   │   └── instance.ts              Shared per-process instance (store + runtime + controller)
│   └── tools/ultra-plan.ts          `ultraplan_start` tool (the /ultra-plan workhorse)
└── test/                            36 vitest tests (5 files)
```

Not implemented (per Phase 1 non-goals): transaction engine, approval UI, architecture/section
workflows, Context Assembler, budgeting, trace collection, evidence promotion/audit, synthesis,
FinalPlan generation, final handoff, durable persistence, embeddings/vector search, repository
indexing, subagent orchestration. `recovery.ts`, `model/policy.ts` and the remaining module files
from the target tree are deferred until their phases need them (no empty mirror files).

The architectural boundary is preserved: no second chat/session abstraction, no LLM runtime, no
crawler/vector/AST infrastructure.

## Repository / OpenCode API Findings

Verified against the **installed** packages (`@opencode-ai/plugin` 1.18.32 and its transitive
`@opencode-ai/sdk`; inspected from `node_modules/*.d.ts`), not from prior knowledge:

- **Plugin contract:** `Plugin = (input: PluginInput, options?) => Promise<Hooks>`;
  `PluginInput = { client, project, directory, worktree, serverUrl, $, experimental_workspace }`.
- **Command registration (native):** the `config` hook can set
  `config.command["ultra-plan"] = { template, description, agent, model }` — the plugin registers
  `/ultra-plan` programmatically; no `command/*.md` files needed.
- **Planning agent + model (native):** `config.agent["ultraplan"] = { mode: "primary", model?,
  prompt?, tools?, permission? }`. A per-agent `model` is how the planning frontier model binds;
  Switchboard's tier→model policy plugs in via `PlanningRuntimeSpec.planningModel`.
- **Tool registration (native):** plugins expose tools via the `tool` hook:
  `{ [name]: tool({ description, args: ZodRawShape, execute(args, ctx) }) }`.
  `ToolContext` provides `sessionID`, `messageID`, `agent`, `directory`, `worktree`, `abort`,
  `metadata()`, `ask()` — session identity comes from tool execution context.
- **Capability exposure:** `AgentConfig.tools` (static per-agent enable/disable) plus the
  `tool.definition` hook (dynamic description/parameter mutation) are the L5 mechanisms.
- **Context injection:** `experimental.chat.system.transform` (session-scoped system prompt) and
  `experimental.chat.messages.transform` exist — available for the Phase ≥3 Assembler.
- **Repository-tool observation:** `tool.execute.before/after` hooks carry
  `{ tool, sessionID, callID, args }` (+ result in `after`) — the future Observation ledger feed.
  `command.execute.before` observes command invocation; `event` exposes the full event union
  (incl. `EventCommandExecuted`, `EventSessionIdle`, `EventSessionCompacted`).
- **Compaction:** `experimental.session.compacting` exists; Plan Memory is compaction-independent
  by design, so this is informational for later phases.
- **Session APIs (SDK client):** `client.session.{list,create,get,children,prompt,promptAsync,
  messages,todo,status,…}`. `session.prompt` accepts `body.agent` and `body.model` — per-request
  agent/model selection exists at the SDK level.
- **NOT available (verified):** no hook/API to imperatively switch the current session's model or
  agent. Model/agent selection binds per command (config), per agent (config), or per prompt
  request (SDK). Therefore `RuntimeCapabilities.dynamicModelSwitch/dynamicAgentSwitch = false`,
  and the planning runtime is applied via the `/ultra-plan` command→agent→model binding. Final
  handoff (Phase ≥3) will likely use `client.session.prompt({ body: { agent, model } })`.

## Architecture-to-Code Mapping

| Frozen spec concept | Code |
|---|---|
| §3 `/ultra-plan` entry, create/resume, DISCOVERY | `core/controller.ts` (`startOrResume`), `runtime/opencode-plugin.ts` (command + agent binding), `tools/ultra-plan.ts` |
| §4 PlanningRun shape | `core/types.ts` `PlanningRun` (plus `handoff_pending`, see deviations) |
| §4.1 stage/lifecycle machine | `core/state-machine.ts` (transition tables; stage and lifecycle kept separate axes) |
| §5 Constraint / Decision / Architecture | `core/types.ts` |
| §6 Section DAG + §6.1/6.2 revisions & contracts | `core/types.ts`, `core/invariants.ts` (cycle/completion/propagation) |
| §7 questions & conflicts blocking finalization | `core/types.ts`, `checkFinalization` |
| §8 reopen → needs_review | `core/invariants.ts` `propagateNeedsReview` |
| §9 Proposal → Approval → Commit | `transaction/types.ts` (shapes); engine = Phase 2; `PlanStore.commitTransaction` throws `phase_boundary` |
| §10 commit chain + snapshots | `memory/snapshots.ts`, `PlanStore.getHeadSnapshot` |
| §12 event log | `memory/events.ts`, `PlanStore.appendEvent/listEvents` |
| §19 ContextTrace | `context/trace.ts` (types only) |
| §22 Observation ledger | `repository/observations.ts` (interface) |
| §23-§26 Evidence / sources / freshness / revision | `repository/evidence.ts`, `PlanStore.putEvidence` (immutable revisions) |
| §30 critical evidence freshness gate | `checkFinalization` (`critical_evidence_not_fresh`) |
| §33/§35 finalization preconditions | `core/invariants.ts` `checkFinalization` |
| Invariant 8 (only PlanCommit mutates committed memory) | `PlanStore` design: committed reads only; `saveRun` rejects changes to `architecture/sections/decisions/finalPlan/headCommit/headSnapshot` (`commit_gated_run_field`) |
| Invariant 4 (≤1 active run/session) | `InMemoryPlanStore.createRun` enforces `multiple_active_runs` (controller checks first; store is the authority) |
| §14 L1 status projection | `memory/renderer.ts` `renderStatus` (structured state only) |

## Tests Added

36 tests across 5 files (`adapters/opencode/test/`, vitest, Node 22):

1. `planning-run.test.ts` — run creation & binding, id sequencing, **two active runs rejected**
   (store + controller level), **repeat `/ultra-plan` resumes**, new run only after
   completed/aborted, stage-graph happy path with revision bumps + `run.stage_changed` events,
   invalid stage transitions, **"execution" rejected as a stage**, `handoff_pending` only from
   `final`, terminal `completed`/`aborted`, golden status block.
2. `revisions.test.ts` — **approved revision immutability** (`duplicate_revision`),
   **amendments create new revisions** (`non_monotonic_revision`), latest-revision read semantics,
   exact-revision refs (positive + `@ts-expect-error` negative type probe).
3. `section-dag.test.ts` — **cycle rejection** (incl. self-dependency, cycle path in error),
   **dependency completion rules** (pending/unknown dependency blocks; approved passes),
   **transitive `needs_review` propagation** (statuses untouched).
4. `finalization.test.ts` — **blocking question** / **blocking conflict** finalization failures
   (non-blocking + resolved variants pass), **stale/invalidated critical evidence** fails,
   supporting staleness does not block, architecture/section approval+validity checks, zero
   sections rejected, deterministic failure ordering.
5. `ultra-plan-command.test.ts` — **`/ultra-plan` creates a run** through the registered tool
   with a stubbed OpenCode `ToolContext`, **repeat resumes the same run**, `config` hook registers
   command + planning agent, runtime capability honesty (incl. `planningModel` propagation),
   `commitTransaction` refused in Phase 1, evidence overwrite rejected, deterministic status
   rendering.

## Verification Results

Repository commands (npm workspaces → `@switchboard/opencode`), all green:

```text
npm run typecheck   → tsc --noEmit over src + test: 0 errors (strict, noUncheckedIndexedAccess)
npm run lint        → eslint . : 0 problems (no `any`, no suppressed rules)
npm test            → vitest run: 5 files, 36/36 tests passed
npm run build       → tsc -p tsconfig.build.json → dist/ emitted (ESM, .d.ts + sourcemaps)
```

Post-build smoke test against the emitted `dist/index.js` (Node ESM): plugin hooks load,
`ultraplan_start` registered; first call prints

```text
Ultra Plan PLAN-001 created
Ultra Plan

Plan: PLAN-001
Lifecycle: active
Stage: discovery
Session: ses_smoke

Architecture: not started
Sections: 0
Open blocking questions: 0
Blocking conflicts: 0
```

and the second call returns `Ultra Plan PLAN-001 resumed | created: false`.

So: OpenCode → `/ultra-plan` → Controller → `PlanningRun(stage=discovery)` → structured
store is demonstrably working end-to-end (with a stubbed `ToolContext` standing in for the live
OpenCode tool host; see Risks).

## Deviations From Frozen Spec

The frozen spec text was **not modified**. Deviations/decisions taken in code, each flagged in
source comments:

1. **`handoff_pending` lifecycle value.** The §4 interface union omits it, but §4.1, §33, and
   invariant 20 require a recoverable handoff state. Implemented as
   `lifecycle: active | handoff_pending | completed | aborted`. *Proposed amendment: add the
   value to the §4 interface.*
2. **No `validation` stage.** The §4.1 diagram shows SYNTHESIS → VALIDATION → FINAL, but the
   frozen stage union has five stages. Implemented: VALIDATION is realized as the finalization
   predicate (`checkFinalization`) gating `synthesis → final`. *Proposed amendment: either add a
   validation stage or document the predicate-as-gate in §4.1.*
3. **Undefined support types given minimal Phase 1 shapes** (spec references them without
   defining them): `Goal`, `WorkRef`, `Alternative`, `Component`, `Boundary`, `DataFlow`,
   `Principle`, `InterfaceSpec`, `InterfaceRef`, `FailureMode`, `Dependency`,
   `ProposalChangeKind`/`ProposalChange.content` (typed `unknown`), `CommittedChange`,
   `ImpactAnalysis`, `MemoryRef`, `EvidenceScope`, `SourceLocator`, `Snapshot`/`SnapshotState`.
   These need freezing by the §38 "Planning Agent Protocol + Tool Contract" layer.
4. **Transitive `needs_review` propagation.** §8 says "dependents"; §35.13 says "downstream".
   Implemented transitively (conservative: needs_review only demands review). *Amendment candidate
   if direct-only propagation is intended.*
5. **Zero sections blocks finalization** (`sections_not_approved`) — "all required sections
   approved" read as requiring a decomposition to exist (spec §6).
6. **"Active for a session" includes `handoff_pending`** (a handoff can be resumed; a new run may
   be started only after `completed`/`aborted`).
7. **Run-header vs committed-memory split inside `PlanningRun`.** `saveRun` (working state:
   stage/lifecycle/goal/constraints/questions/conflicts/activeWork) hard-rejects changes to
   commit-gated pointer fields (`architecture`, `sections`, `decisions`, `finalPlan`,
   `headCommit`, `headSnapshot`). This is the enforceable form of invariant 8 given the run
   aggregates committed refs.
8. **Evidence has a narrow write API** (`putEvidence`) although evidence is not committed Plan
   Memory — justified by §21/§25 (separate trust domain; evidence revisions need no approval).
   Immutable-revision discipline still enforced.
9. **Location/naming:** the harness lives at `adapters/opencode/` (Switchboard monorepo
   convention, README structure) rather than a top-level `opencode-ultra-plan/` package; tests at
   `adapters/opencode/test/` rather than the root `tests/` (reserved for cross-adapter
   integration). Planning-run ids are `PLAN-001`-style per the spec examples.
10. **Event vocabulary (initial):** `run.created`, `run.resumed`, `run.stage_changed`,
    `run.lifecycle_changed`, `runtime.activated`, `status.reported` — extendable, append-only.

## Risks / Open Issues

- **In-memory store:** planning state is lost when the OpenCode server process restarts. Fine for
  Phase 1 integration proof; durable persistence (plugin-owned storage) is mandatory before real
  planning runs. The singleton must then become per-project/workspace-namespaced.
- **Live-runtime wiring unverified:** tool execution was driven with a stubbed `ToolContext` and
  the `config` hook was exercised against config objects in tests, but the plugin has not yet been
  loaded by a live OpenCode server (Bun). A live smoke test (`opencode` with the plugin
  registered) should be part of Phase 2 acceptance.
- **Planning model not yet selected:** `PlanningRuntimeSpec.planningModel` is the injection
  point; until Switchboard's tier→model policy feeds it, the `ultraplan` agent inherits the
  user's default model.
- **Handoff mechanism:** likely `client.session.prompt({ body: { agent, model } })` — SDK-level
  capability verified in types, but live behavior (session continuity across agent switch) still
  to be validated.
- **Proposal change vocabulary** is `unknown`-typed by design until the §38 tool contract freezes
  it; the transaction engine must not be built against the current placeholder.
- ESLint stays at `recommended` (no type-aware rules) to keep the toolchain light; consider
  `recommendedTypeChecked` later.

## Recommended Phase 2 Starting Point

1. **Freeze the §38 Planning Agent Protocol + Tool Contract** (which tools exist per state, which
   are read-only, which create proposals) — it unblocks items 2-4.
2. **Transaction engine:** implement `PlanStore.commitTransaction` per spec §9.4 (verify run
   active, proposal `awaiting_approval`, proposal hash ↔ approval, base snapshot, dependencies,
   hard constraints, conflicts, critical evidence; apply changes atomically; create immutable
   revisions + events + Snapshot + PlanCommit; move HEAD) — the interfaces here were shaped for
   exactly this.
3. **Durable Plan Memory persistence** behind the existing `PlanStore` interface (plugin-owned
   storage), replacing `InMemoryPlanStore` in `runtime/instance.ts` only.
4. **Observation ledger wiring:** feed `tool.execute.before/after` into `ObservationLedger`, then
   evidence promotion.
