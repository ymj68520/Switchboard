# Phase 2A Implementation Report

**Scope:** Planning Agent Protocol + Tool Contract freeze (spec §38) and live OpenCode integration validation.
**Spec baseline:** `docs/opencode/spec/opencode-ultra-plan-architecture.md` (frozen, unmodified).
**New contract document:** `docs/opencode/spec/opencode-ultra-plan-agent-protocol.md` (v0.1).

---

## Implemented

All in `adapters/opencode/` unless noted:

- **Capability matrix** — `src/core/capabilities.ts`: `ULTRA_PLAN_CAPABILITIES`, the authoritative
  `getCapabilities(run)` decision function, `assertCapability`, `requireRun`. Single source of
  truth; tools carry no stage rules of their own.
- **Tool contract registry** — `src/tools/contracts.ts`: `ToolContract` (authority class,
  capability gate, derived `allowedStages`/`allowedLifecycle`, `requiresActiveRun`,
  `mutatesCommittedMemory: false`), `FORBIDDEN_TOOL_NAMES`. Stage/lifecycle columns are DERIVED
  from `getCapabilities`, so registry and enforcement cannot drift.
- **Model-visible tool surface** — `src/tools/registry.ts`: 11 tools (`ultraplan_start`,
  `ultraplan_status`, `plan_memory`, `ultraplan_record_question`, `ultraplan_resolve_question`,
  `ultraplan_raise_conflict`, `ultraplan_promote_evidence`, `ultraplan_prepare_proposal`,
  `ultraplan_request_completion`, `ultraplan_request_reopen`, `ultraplan_request_synthesis`), all
  with zod-validated args and structured results carrying machine-readable error codes
  (`ERROR [code] …` output + `metadata.errorCode`). No approve/commit/force tools exist.
- **Controller-side authorization** — `UltraPlanController.authorizeTool(sessionID, contractName)`
  resolves the run per contract and enforces the capability matrix before any operation; new
  controller operations: `readMemory`, `recordQuestion`, `resolveQuestion`, `raiseConflict`,
  `promoteEvidence`, `prepareProposal`, `requestCompletion`, `requestReopen`, `requestSynthesis`.
- **L0 Planning Protocol** — `src/context/protocol.ts`: deterministic protocol fragment (rules +
  live capability checklist), rendered from static code, injected via
  `experimental.chat.system.transform` only for sessions with an active run (`src/index.ts`).
- **Read-only Plan Memory boundary** — exact-revision semantics enforced: explicit historical
  revisions that do not exist fail with `unknown_reference` (never resolved to latest); decision
  reads require an exact revision; `dependenciesOf` returns dependency contracts.
- **Observation → Evidence promotion** — `src/repository/observations.ts`
  (session-scoped `ObservationLedger` + in-memory impl): `tool.execute.after` records repository
  tool activity; `promoteEvidence` REQUIRES provenance (direct ⇒ existing session observations,
  sources built from them; derived ⇒ resolvable upstream evidence; uncertain ⇒ forced
  `needs_validation` freshness).
- **Proposal intent boundary** — Harness assigns `PROP-###`, binds run + scope + HEAD snapshot
  (`createdFrom`), freezes content (`status="ready"`), computes canonical SHA-256
  (`src/transaction/hash.ts`, over the proposal minus hash; `Proposal.hash?` added). Closed
  change vocabulary at this boundary; `final_plan` type and unknown kinds rejected.
- **Synthesis gate** — `requestSynthesis` runs `checkFinalization` and either performs the
  Harness-authoritative `synthesis → final` transition or fails with `finalization_blocked` +
  the exact failure list.
- **Store extensions** — `findLatestRunBySession`, initial HEAD snapshot (commit=null) at run
  creation, `saveProposal`/`listProposals` (id reuse rejected → `proposal_immutable`),
  `getEvidence` (exact-revision reads).
- **Live validation support** — `scripts/opencode-live-smoke.mjs` (root) + `npm run smoke:opencode`.
- **Tests** — 29 new (65 total, 7 files).

## Planning Agent Protocol

Frozen as `docs/opencode/spec/opencode-ultra-plan-agent-protocol.md` (v0.1): agent
responsibilities and prohibitions, tool inventory, authority classes, the state/capability
matrix, input/output contracts, approval/proposal authority boundaries, evidence promotion
rules, the VALIDATION interpretation, and runtime capability assumptions. The matrix is pinned
byte-for-byte against `getCapabilities` by `test/capabilities.test.ts` — code and document
cannot diverge silently.

## Tool Contract

`ToolContract` semantics (brief §5) realized as:

```ts
interface ToolContract {
  name: string;
  authority: "read" | "working_state" | "proposal_intent" | "repository_evidence";
  capability: UltraPlanCapability;          // enforced via getCapabilities
  allowedStages: PlanningStage[];           // derived from getCapabilities
  allowedLifecycle: PlanningLifecycle[];    // derived from getCapabilities
  requiresActiveRun: boolean;
  readonly mutatesCommittedMemory: false;   // true is unrepresentable for model-visible tools
}
```

No model-visible tool can create an Approval or a PlanCommit: no such authority class exists,
`commitTransaction` remains behind the `phase_boundary`, and the forbidden-name list is tested.

## Capability Matrix

See the protocol document §4 (authoritative table) and `test/capabilities.test.ts`
(`DOCUMENTED_MATRIX`). Highlights: discovery has questions+evidence but no conflicts/proposals;
synthesis is read-only plus blocker-raising, reopen, and the finalization request; `final` and
`handoff_pending` expose reads only; completed/aborted runs expose reads + new-run start only.

## OpenCode API / Runtime Findings

Re-verified against installed dependencies this phase: local `@opencode-ai/plugin` 1.18.32 /
SDK 1.18.32 type definitions unchanged from Phase 1 findings; global CLI is `opencode-ai`
1.18.31 (the version used for live validation — the minor drift is harmless; the binary
exhibited all APIs the 1.18.32 types declare for our surface).

Newly verified LIVE (not just from types):

- `.opencode/plugin/*.js` files auto-load; a plugin can re-export a built ESM `dist` bundle.
- The `config` hook's `command`/`agent` registrations appear on `GET /config` of a running
  server.
- Plugin `tool` hooks appear on `GET /experimental/tool/ids` alongside built-in tools.
- `POST /session/{id}/command { command, arguments }` executes a registered command through the
  real agent/model pipeline (this is how `/ultra-plan` was driven without the TUI).
- The `opencode` provider ships free gateway models (`opencode/*`) usable without stored
  credentials; `opencode/ling-3.0-flash-fin-free` completed the smoke prompts.
- Still absent (types + live): an imperative per-session agent/model switch. Planning/execution
  runtime selection binds per command/agent/prompt. `dynamicModelSwitch`/`dynamicAgentSwitch`
  remain declared false.

## Live Runtime Validation

**PASSED — not blocked.** `npm run smoke:opencode` against a real `opencode serve` (Windows,
opencode-ai 1.18.31, free gateway model), plugin loaded from the built `dist`:

```text
PASS  opencode serve starts and serves HTTP — http://127.0.0.1:27850
PASS  plugin loads without errors
PASS  config hook registered /ultra-plan command — agent=ultraplan model=(inherit)
PASS  config hook registered ultraplan planning agent — mode=primary model=(explicit default inheritance)
PASS  Ultra Plan tools exposed to the runtime — ultraplan_start, ultraplan_status, plan_memory,
      ultraplan_record_question, ultraplan_resolve_question, ultraplan_raise_conflict,
      ultraplan_promote_evidence, ultraplan_prepare_proposal, ultraplan_request_completion,
      ultraplan_request_reopen, ultraplan_request_synthesis
PASS  session created — ses_f2c97f82affezT5A3C3WSxqMRk
PASS  /ultra-plan creates PlanningRun(discovery) with real sessionID (first invocation)
      — ultraplan_start executed (create path)
PASS  deterministic status block returned — Ultra Plan\n\nPlan: PLAN-001
PASS  second /ultra-plan RESUMES the same run (created=false path) — ultraplan_start executed (resume path)
PASS  no second OpenCode session was created — before=3 after=3

=== 10/10 checks passed ===
```

The live message log showed the real model invoking `ultraplan_start` (state=completed) and
echoing the exact status block with `Session: ses_…` — i.e. the ToolContext sessionID flowed
end-to-end: `real OpenCode → plugin load → /ultra-plan → real ToolContext.sessionID →
UltraPlanController → PlanningRun(stage=discovery)`.

Per-step evidence for each of the 11 criteria in the Phase 2A brief: criteria 1–5 and 7 map to
the server/config/tool checks above; 6, 8, 9 to the two command executions; 10 to the verbatim
status block; 11 to the unchanged session count. (Earlier manual inspection of a live session
additionally showed both tool parts and the assistant echoing the status block verbatim.)

## Tests Added

`test/capabilities.test.ts` (7) + `test/protocol-boundary.test.ts` (22). Mapping to the brief's
required list — all covered:

1/2/3/4/17 stage sets, lifecycle restrictions, terminal runs, handoff-pending, and the full
documented matrix (`DOCUMENTED_MATRIX` vs `getCapabilities`); 5 read tools never mutate (state
diff asserted + authority classes); 6/7 no model-visible tool creates Approval/PlanCommit
(authority classes, forbidden names, `commitTransaction` phase boundary); 8 invalid-stage
invocations fail in the controller even when called directly (`capability_not_available`,
`no_active_run`, `finalization_blocked` vs capability gating); 9 proposal bound to active
run/scope/HEAD snapshot (`PROP-001`, `SNAP-001`, hash); 10 proposal frozen at the intent
boundary (content-addressed hash; id reuse → `proposal_immutable`); 11 exact revision reads
(missing explicit revision → `unknown_reference`, decision requires revision); 12/13 evidence
promotion requires real observation provenance (no ids → `missing_provenance`; unknown id →
`unknown_reference`; real ledger observation → provenance-backed `EVD-001`; derived freshness
degradation; uncertain forced `needs_validation`); 14 protocol rendering deterministic + stage-
dependent capability checklist; 15 `/ultra-plan` still creates/resumes exactly one run (tool
surface); 16 planning model propagation + explicit default inheritance; plus working-state
operations, hook-level observation recording → evidence promotion, and status/no-run reporting.

## Verification Results

Repository commands (npm workspaces → `@switchboard/opencode`), all green:

```text
npm run typecheck → tsc --noEmit (strict, noUncheckedIndexedAccess): 0 errors
npm run lint      → eslint .: 0 problems (no `any`, no disabled rules, no skipped tests)
npm test          → vitest run: 7 files, 65/65 tests passed
npm run build     → tsc -p tsconfig.build.json → dist/ emitted; smoke loads dist under real opencode
npm run smoke:opencode → 10/10 live checks passed (see above)
```

## Phase 1 Deviations Classification

| Phase 1 deviation | Class | Rationale / disposition |
|---|---|---|
| `handoff_pending` lifecycle value | **A** (spec defect/inconsistency) | §4 union omits it; §4.1, §33, invariant 20 require it. Kept; amendment proposal: add to §4 interface. |
| VALIDATION stage ambiguity | **A** (inconsistency) with **B** resolution | Diagram vs frozen union conflict. Resolved for implementation: VALIDATION is the deterministic gate on `synthesis → final` (protocol doc §9). No persisted stage added. |
| Transitive `needs_review` propagation | **B** (unresolved semantics) | §8 "dependents" vs §35.13 "downstream". Conservative transitive reading kept; amendment candidate if direct-only intended. |
| Zero-section finalization blocked | **C** (implementation-only) | Spec silent; decomposition is a precondition in spirit (§6). |
| Run-header vs committed-memory split | **C** (implementation-only) | Enforceable form of invariant 8 given PlanningRun aggregates committed refs. |
| Evidence write boundary (`putEvidence`) | **C** (implementation-only) | Follows §21/§25 separate trust domain; immutability still enforced. |
| Module location (`adapters/opencode/`, `test/` inside package) | **C** (implementation-only) | Switchboard monorepo convention (README). |
| Event vocabulary (initial) | **C** (implementation-only) | Append-only, extensible; refined values observed live (run.created/resumed, stage/lifecycle changed, runtime.activated, status.reported). |

## Deviations From Frozen Architecture

New in Phase 2A (frozen file untouched):

1. **Initial HEAD snapshot at run creation** (`Snapshot.commit = null`) — **C**. `Proposal.createdFrom`
   (spec §9.1) must always bind a snapshot; the store now materializes one at run creation. Consistent
   with the commit chain model (it is S0 with no commit). Amendment candidate: document S0 in §10.
2. **Proposals frozen at creation** (`status="ready"`, immutable, hashed) — **C**. The spec freezes at
   `awaiting_approval` (§9.2); v0.1 has no draft-editing workflow, so the stricter boundary is entered
   early. The hash makes the §9.3 binding (`proposalID + proposalRevision + proposalHash + actor=user`)
   verifiable. `Proposal.hash?` field added for this purpose.
3. **Closed change vocabulary at the tool boundary** — **B**. The tool layer accepts only
   `add_decision, amend_decision, amend_section, raise_question, resolve_question,
   complete_architecture, complete_section`; everything else → `proposal_kind_unsupported`. The
   domain type keeps the wider Phase 2B vocabulary; nothing is hidden behind untyped content.
4. **`request_synthesis` performs the stage move** — follows from the VALIDATION interpretation; the
   model may only REQUEST, the Harness validates and transitions (§31/§33 preconditions unchanged).
5. **`ObservationLedger` made session-scoped** — **C**. Phase 1's type shell was unwired; provenance
   requires tying observations to the planning session that produced them.
6. **Tool-name prefixes** (`ultraplan_*`, `plan_memory`) — **C**. Matches the Phase 1 `ultraplan_start`
   precedent; the brief allowed naming adaptation.

## Risks / Open Issues

- **In-memory store still** — live validation ran against `InMemoryPlanStore`; a server restart
  loses runs. Durable persistence is the Phase 2B priority and slots in behind `PlanStore`.
- **Planning model quality** — the free gateway model satisfied the smoke script (tool invocation +
  verbatim status echo) but is not a frontier planner; Switchboard's tier policy should bind a real
  frontier model via `PlanningRuntimeSpec.planningModel` before real planning runs.
- **Approval UX undecided** — `ToolContext.ask` / `permission.ask` are the verified structured
  primitives; the actual approval interaction (which one, with what metadata binding) is designed but
  unbuilt, intentionally.
- **Evidence provenance depth** — observations currently record tool name + best-effort locator
  (file/command/pattern). Content fingerprints and per-tool arg mapping refine with the observation
  ledger work.
- **Port/process hygiene in the smoke script** — fixed after diagnosing an orphaned server from the
  first run (random port + process-tree kill + explicit exit). Windows-only nuance; script exits
  cleanly now.

## Recommended Phase 2B Starting Point

Implement the **Proposal → Approval → PlanCommit engine** against the frozen contract:

1. `PlanStore.commitTransaction` per spec §9.4: verify run active, proposal `ready`/hash-bound
   approval, base snapshot (`createdFrom` vs current HEAD — optimistic concurrency), dependencies,
   hard constraints, conflicts, critical evidence; then atomically apply changes, create immutable
   revisions, append events, materialize the Snapshot, create the PlanCommit, move HEAD.
2. The approval boundary on top of the verified `ToolContext.ask`/`permission.ask` primitives,
   binding `{ proposalID, proposalRevision, proposalHash, actor: "user" }`.
3. Durable `PlanStore` (plugin-owned storage) replacing `InMemoryPlanStore` in
   `runtime/instance.ts` only.
4. Architecture/section working workflows on top (the tools that prepare the proposals this engine
   consumes already exist and are contract-frozen).
