# Phase 15 — ExecutionIssue, Successor PlanningRun & Scoped Replanning

Status: IMPLEMENTED (this note accompanies the Phase 15 feat commit).
Baseline: Phase 14 FROZEN/PASS (commits `6c0fdc4` + `20e1995` + `e7aa57a` +
`7e4571d`), schema v11, 15 MCP tools.

## What Phase 15 adds

The single loop closed by this phase:

```text
completed FinalPlan
  → same-session Build
  → Build discovers approved semantics cannot be preserved
  → report_execution_issue        (immutable ExecutionIssue)
  → Build semantic mutation pauses (EXECUTION_REPLAN_REQUIRED)
  → explicit user /phase-plan
  → NEW PlanningRun (successor) from the immutable FinalPlan baseline
  → only affected scope reopens; the rest inherits completion
  → normal Evidence / Proposal / Approval / PlanCommit workflow
```

Core invariant: the old completed PlanningRun is NEVER reactivated, the old
FinalPlan is NEVER rewritten, and new planning ALWAYS happens in a new
PlanningRun with a new run id.

## Schema v12 (`012-execution-issue-successor-baseline`)

Seven new tables, ALL immutable append-only history (no_update/no_delete
triggers; the domain has NO mutable operational table — "open" is derived,
§18):

| table | purpose |
| --- | --- |
| `execution_issues` | the immutable defect report; UNIQUE(run_id, operation_id) is the idempotency fence (§15) |
| `execution_issue_refs` | exact FinalPlan closure refs (CHECK-typed: architecture/section/section_contract/decision/constraint; exact revisions) |
| `execution_issue_adoptions` | issue → successor run; PRIMARY KEY + UNIQUE(issue_id) is the DB fence for one-successor-only (§74) |
| `planning_run_baselines` | the immutable successor anchor; UNIQUE(successor_run_id) (§26) |
| `planning_run_baseline_issues` | the exact adopted set (deterministic positions; hashed into issue_set_hash) |
| `planning_run_baseline_scopes` | per-Section `inherited_completed | needs_review` + exact origin MemoryRef (§52/§55) |
| `planning_run_baseline_materializations` | baseline_id PK: the unique first-commit materialization record (§53); `materialized ⟺ row exists` |

Deliberately NOT created (§6): execution_steps / execution_progress /
execution_task_states / implementation_events / build_progress /
step_completions — Phase Plan is still not an execution orchestrator.
NO backfill (§83): legacy schema-11 completed runs receive no fabricated
issues or baselines; all v12 tables start empty (validated by tests).
`SUPPORTED_SCHEMA_VERSION = 12`; `validateSchemaV12` adds bounded identity
facts at store open (hash↔canonical for issues and baselines, exact
FinalPlan/Handoff bindings, adoption↔baseline coherence, materialization in
the successor's own commit chain).

## ExecutionIssueV1 (`src/core/execution-issue.ts`)

Pure core: kind vocabulary, canonical shape, deterministic hash, exact-ref
validation, and the deterministic scope derivation. No SQLite/host/MCP.

- Kind vocabulary (§2, frozen): `hard_constraint`, `invariant`,
  `approved_interface`, `section_contract`, `approved_decision`,
  `explicit_dependency`, `architecture_choice`,
  `critical_repository_assumption`, `missing_design_obligation`. No
  bug/misc/other/problem/warning exists.
- affectedRefs may ONLY cite the approved FinalPlan closure, EXACTLY (§10):
  `SEC-A@4` may only be cited as `SEC-A@4`; a bare id, an older revision, or
  a foreign id is `EXECUTION_ISSUE_SCOPE_INVALID`. At least one ref is
  mandatory (§11 — no completely unscoped issue; a system-wide defect binds
  the exact ArchitectureRef).
- Canonical hash (§8) covers content only — issue id, timestamps, session id,
  binding generation, and toolUseId are excluded; affectedRefs are sorted
  deterministically. An idempotent replay of the same semantic payload
  hashes identically.

## report_execution_issue (16th MCP tool, §12–§20)

- Input: ONLY `kind`, `summary`, `detail`, `affected_refs` — no
  run_id/final_plan_id/handoff_id/workspace_id/session_id/binding
  generation/repository revision/successor field exists to accept (§12).
  `assertExactBusinessFields` rejects authority fields outright.
- Authority (§13): EXECUTION HostContext ONLY (domain-separated); the store
  side is revalidated in-tx via `requireBuildReadAuthorityInTx` (completed
  run + approved FinalPlan + delivered handoff + attached exact-session
  binding + exact generation). A Planning HostContext fails with
  HOST_CONTEXT_INVALID before any store access.
- No human approval (§14): it records a Build-discovered defect, not a
  design authorization.
- Idempotency (§15): operation identity `execution-issue:<signed
  toolUseId>`; the same semantic payload replays to the SAME issue
  (`idempotent: true`), a different payload is `IDEMPOTENCY_CONFLICT`. The
  comparison is over the model-authored fields (kind/summary/detail/refs),
  so server-side git drift between retries never fabricates a conflict.
- Repository context (§16): captured SERVER-SIDE at report time from the
  workspace's git HEAD via the same fixed-argv / shell=false / bounded
  mechanism as the handoff baseline (`deriveRepositoryBaseline`); directory
  workspaces record `revision = null`. Model-provided revisions are
  unrepresentable.
- Reporting mutates NOTHING else (§4): the write transaction inserts only
  the issue + refs rows. Predecessor immutability is test-pinned (E5–E7).

## Build replanRequired projection + semantic mutation guard (§19–§21)

- `get_state` (execution authority) gains
  `executionIssues: { openCount, replanRequired }`; `get_context(detail=build)`
  gains the compact `openExecutionIssues` list (id/kind/summary — never the
  full detail by default).
- PreToolUse: once `openCount > 0`, the host mutation family
  (Write/Edit/MultiEdit/NotebookEdit/Bash/PowerShell/Agent) is denied
  fail-closed with `EXECUTION_REPLAN_REQUIRED`; Read/Grep/Glob/ToolSearch and
  the phase-plan read tools stay available; `report_execution_issue` itself
  is signed with an execution context. With zero open issues, Phase 14
  behavior is preserved byte-for-byte (Build writes are the host's business).

## Successor creation (§22–§43) — `src/application/successor-run-service.ts`

Entry: the Build-bound session invokes `/phase-plan` (fresh signed
EntryIntent verified FIRST, §24) → `start_or_resume` sees the attached
ExecutionBinding and classifies:

- successor already exists → `SUCCESSOR_RUN_ALREADY_STARTED` (§73);
- no open issue → `EXECUTION_ISSUE_REQUIRED` (§23 — no silently
  "baselined on nothing" successor);
- otherwise `createSuccessor` runs the ONE creation transaction (§38):
  validate execution authority → load the deterministic open-issue set (§30;
  the model never picks issue ids) → derive the affected scope → capture the
  repository at replan start server-side (§62) → insert the successor run
  (NEW id, lifecycle active, stage architecture|detail — never discovery,
  §36; goal inherited from the baseline design intent) → append the
  DB-fenced adoptions (§74; `planning_run_baseline_issues` FK-references the
  adoption row, so adoptions are inserted first) → freeze the immutable
  baseline (canonical payload + `planningRunBaselineHash`; binds the exact
  FinalPlan id/hash, the Final PlanCommit snapshot/commit pair, the delivered
  handoff id/hash, the issue-set hash, and the repository at replan start) →
  record per-Section scope with exact origin refs → attach the successor
  planning SessionBinding (generation exactly 1, same session/workspace,
  §40) → detach the predecessor ExecutionBinding (generation +1, §39).

Response: `started_successor` with baseline, adopted issues, initial stage,
affected scope, and both binding states (§70 — never "resumed": the old run
was not resumed, it stays completed forever, §25).

Scope derivation (§32–§34, `deriveAffectedScope`) is Core-derived
deterministically — no NLP over summary/detail:

- architecture-level (ANY hit → stage architecture, ALL sections
  needs_review, nothing inherits): an ArchitectureRef; kind
  hard_constraint / architecture_choice / critical_repository_assumption;
  a Decision whose committed content scope is not an exact FinalPlan
  section id; missing_design_obligation not fully bound to section refs
  (conservative default); invariant/approved_interface cited with an
  ArchitectureRef.
- detail-level: affected sections = exact SectionRef/SectionContractRef
  sections (+ section-scoped decisions), then downstream closure over the
  predecessor FinalPlan Section DAG (BFS over dependency identities).
  Everything else is `inherited_completed`.
- `activeWork = null` at creation (§35); pre-materialization
  `select_section` is bounded to needs_review baseline sections (§65).

Concurrency (§72–§75): the whole creation is one BEGIN IMMEDIATE
transaction — a raced second creation observes the detached execution
binding (STALE_EXECUTION_BINDING) or the adopted baseline
(SUCCESSOR_RUN_ALREADY_STARTED); the UNIQUE(issue_id) adoption fence is a
DB law, pinned by a direct-duplicate-insert test.

The old execution authority fences immediately after the swap (§76/§39):
outstanding signed execution contexts fail `EXECUTION_CONTEXT_NOT_AVAILABLE`.
`/clear` and forks transfer nothing (existing Phase 7 rules, §41/§103).

## Baseline-before-HEAD (§42–§45/§80)

The creation transaction fabricates NO Proposal, NO Approval, NO PlanCommit,
NO snapshot, NO HEAD, and NO memory revisions (§42/§43) — the predecessor's
approved FinalPlan is the baseline design, not a new design mutation. Until
the first authorized commit:

- `read_memory` on the successor resolves exact baseline-closure refs from
  the predecessor's immutable Plan Memory with
  `authority: "successor_baseline"` (§44/§45); historical/superseded
  revisions fail `BASELINE_MEMORY_REF_NOT_AUTHORIZED`.
- `get_state`/`get_context` expose the successor view (§78/§79): baseline
  FinalPlan, adopted issue summaries, affected scope, repository at replan
  start, `materialized` flag, local HEAD once it exists.
- `request_reopen` is unchanged (§80): the initial reopened state comes from
  the baseline scopes, not from reopen requests.

## ProposalCanonicalV4 and baseline materialization (§46–§59)

- Context v5 (`CONTEXT_MODEL_VERSION = 5`, `context-epoch:v5`): the
  PhasePlanContext gains the explicit `successorBaseline` block (baseline
  id/hash, issue-set hash, predecessor run, FinalPlan, issue summaries,
  scope, materialized flag); the epoch inputs gain
  `(baselineId, baselineHash, materialized)`. The Recovery Capsule gains the
  REQUIRED `successor baseline` segment (§47/§102): new run id, baseline
  FinalPlan, predecessor run, issue summaries, reopened/inherited scope, and
  `Baseline materialized: no|yes` — the capsule alone reconstructs the
  successor lineage after /compact.
- `prepare_proposal` on an unmaterialized successor uses the baseline
  FinalPlan closure as the BASE (§48) — carried refs read from the
  predecessor's Plan Memory (never copied at prepare time) — and freezes a
  canonical **V4** (`buildSuccessorProposalCanonical`): V2 semantics plus the
  `successorBaseline` binding `{baselineId, baselineHash, finalPlanId,
  finalPlanHash, issueSetHash}` (§49). Formal Approval therefore authorizes
  which prior FinalPlan + which ExecutionIssue set + which proposed change,
  inseparably. V1/V2/V3 builders, parsers, and goldens are untouched (§50);
  historical hashes never change.
- Materialization (§51/§53) happens ONLY inside the first authorized
  successor PlanCommit transaction: the engine verifies the V4 binding
  against the Store (`SUCCESSOR_BASELINE_STALE` on any mismatch), refuses a
  second materialization, copies the baseline closure revisions into the
  successor run BYTE-IDENTICALLY (content/projections/contract/created_at —
  the schema namespaces by run_id, so identity+revision carry over with no
  renumbering; §52's ARCHITECTURE_BLOCKER condition does not arise), and
  inserts the unique `planning_run_baseline_materializations` row
  (`origin_manifest_json` records every origin MemoryRef). The candidate
  snapshot = carried baseline + approved changes (§59); HEAD then moves
  normally.
- Inherited completion (§54–§58): at materialization, needs_review baseline
  sections are registered as the successor's OWN workflow sections (OPEN,
  honest provenance — never fabricated completions); inherited_completed
  sections stay row-less. The effective-state merge
  (`getBaselineScopeForSectionInTx` + local-rows-win) is wired into exactly
  three decision points: `evaluateDetailCompletionInTx` (E53),
  `gateSectionCompletionInTx` dependency checks (inherited dependencies
  count ONLY at the exact candidate revision), and
  `buildFinalizationFactsInTx` (inherited sections satisfy the FinalizationGate
  at their exact origin revision). A local row ALWAYS wins — once an
  inherited section is amended, inheritance ceases (§58) and it becomes an
  ordinary local section (registered on amend). Unaffected sections are
  NEVER forced through fake reapproval (E49); affected sections can NEVER
  inherit completed validity (E50).
- The last affected completion reaches DETAIL_COMPLETE through the merge and
  freezes the successor's OWN SynthesisInput (E53/E54) — predecessor
  SynthesisInput/Manifest/ValidationReport are never reused (E55); the
  successor pipeline then proceeds through the normal Phase 12/13 gates
  toward a NEW FinalPlan/Handoff (§68/§69 lineage via the baseline row).
- Successor Evidence isolation (§60/§61): required evidence must be
  same-run (predecessor refs fail `EVIDENCE_STATE_INVALID`); new
  observations captured under the attached successor run belong ONLY to it —
  predecessor observation/evidence counts are untouched.

## Why the completed predecessor is never reactivated (§25/§104)

Reactivation would silently rewrite approved history and break every fence
built on the terminal lifecycle (finalization authority, execution
authority, audit lineage). The successor path gives replanning a legal form
instead: new run, immutable baseline, scoped reopening. No service API can
flip `completed → active`; a direct transition attempt fails closed
(ownership fence `BINDING_DETACHED` on the detached planning binding), and
the state machine has no such transition. Pinned by an explicit test.

## Same-session default → Plan Mode (§37)

The successor entry reuses the verified Phase 14 chain verbatim:
PreToolUse `ask` (start_or_resume entry) → PermissionRequest
`setMode(plan, destination=session)` → MCP handler. No settings persistence,
no new Claude process. E39/E40.

## Why execution progress stays out of scope (§6/E63)

Progress tracking would make Phase Plan an execution orchestrator — a
different product with different correctness obligations. The v0.1 boundary
is: Phase Plan authorizes and baselines semantic work; it never schedules,
monitors, or measures it. No v12 table, tool, or hook observes Build
progress.

## Why takeover/abort remain deferred (E64/E65)

`takeover_run` / `abort_run` are ownership-control operations. Mixing them
into the successor-baseline phase would entangle ownership transfer with
baseline correctness. They stay deferred to a later operational-control
phase; the MCP surface is EXACTLY the 16-tool set (E66).

## Files

- Core: `src/core/execution-issue.ts`, `src/core/successor-baseline.ts`,
  `src/core/proposal-canonical.ts` (V4), `src/core/execution-handoff.ts`
  (unchanged)
- Store: `src/store/migrations/012-execution-issue-successor-baseline.ts`,
  `src/store/execution-issues.ts`, `src/store/successor-baselines.ts`,
  `src/store/plan-memory.ts` (`materializeBaselineRevisionsInTx`),
  `src/store/schema.ts` (validateSchemaV12), `src/store/constants.ts` (v12)
- Application: `src/application/execution-issue-service.ts`,
  `src/application/successor-run-service.ts`, proposal-service (V4 base),
  plan-commit-engine (materialization + effective-state gates),
  section-workflow-service (scope merge + bounded selection),
  finalization-service (scope merge), context-read-model (`getSuccessorBaseline`)
- MCP: `src/mcp/tools.ts` (report_execution_issue, successor entry, Build
  projections, successor_baseline reads, successor views)
- Hooks: `src/hooks/handlers.ts` (EXECUTION_REPLAN_REQUIRED guard,
  report_execution_issue execution signing), `src/host/host-context.ts`
  (tool union), `src/runtime/errors.ts` + `exit-codes.ts` (§86 vocabulary)
- Context: `src/context/types.ts` (v5), `epoch.ts`, `assembler.ts`,
  `render.ts` (successorBaselineSegment), `capsule.ts`
- Skill: `skills/phase-plan/SKILL.md` (§88 minimal rules)
- Tests: `test/execution-issue-successor.test.ts` (40 tests) plus the
  updated migration/surface/context pins across the existing suite
