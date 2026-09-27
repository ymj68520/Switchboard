# R2 Context Architecture Report

**Phase:** R2 — Deterministic Context Architecture, Budgeting & Compaction Independence
**Scope:** Exit-review blocker B-D ONLY (frozen Context Architecture §13-§16 + §28 retrieval + ContextTrace/observability + the live compaction question). No unrelated product features were added.
**Baseline:** `v0.1-architecture-exit-review.md` (NOT READY; B-A/B-B/B-C resolved by R1, B-D remaining) + `r1-blocker-remediation-report.md` (R1 COMPLETE) + the frozen architecture (unmodified — zero diffs) + protocol v0.12.
**Date:** 2026-09-27

---

## Exit-review Baseline

The v0.1 Exit Review dispositioned the authority chain as real (30/30 Core Invariants satisfied, zero bypasses) and identified exactly one remaining release blocker after R1:

```text
B-D — Context Architecture: §§13-16 + §28 retrieval unimplemented;
      only the L0/L5 renderer existed; no structural retrieval, no
      projection levels, no Budget Manager, no L2/L3 auto-supply, no
      evidence retrieval priorities, no runtime trace.
```

R2 resolves ONLY B-D. Per the exit review, the required exit tests are: per-layer injection tests, budget ordering + P0-preservation tests, trace-reason tests, and the live compaction proof; plus "system-transform executes the assembler" live.

## Audit Findings

Audit-first was honored (brief §2). Findings that shaped the implementation:

- **Host surface (verified against the installed `@opencode-ai/plugin`/SDK 1.18.32 types, not assumed):** `experimental.chat.system.transform` exists as today (`input {sessionID?, model}`, `output {system: string[]}`). The host DOES expose a real, triggerable, observable compaction surface: `POST /session/{id}/summarize` (the TUI `session.compact` path), the `session.compacted` event, and the `experimental.session.compacting` / `experimental.compaction.autocontinue` plugin hooks. Therefore the live compaction proof is mandatory and was executed (§71), not documented-away under §74.
- **Host token estimator:** the runtime exposes NO reliable tokenizer API for arbitrary candidate context → a deterministic documented estimator is used (see Token Estimation). No model-specific tokenizer subsystem was added (explicit non-goal).
- **Durable publication is whole-document atomic** and `DurablePlanStore` refreshes from disk per out-of-lock read. Multi-read assembly could therefore straddle a commit (L1 from HEAD A, Architecture from HEAD B) unless the read boundary is a store-level operation: one refresh, then all family reads from the single hydrated document (brief §5's `capturePlanningContextState`, realized on the store boundary itself).
- **Current-state resolution:** the HEAD Snapshot already carries exact revision pointers (`architectureRevision`, `sectionRevisions`, `decisionRevisions`) — the assembler resolves CURRENT artifacts strictly through those pointers, never registry "latest". This makes R2's context semantics identical to the SynthesisInput authority resolution and makes the §63 R1-composition case structurally provable (`run.sections` is empty after an amendment; the old DAG cannot enter current context).
- **Existing reusable authorities:** `getCapabilities` (L5 — no second matrix authored), `SectionRevision.projection.compact` + SectionContracts (stable §17 projections — reused verbatim), the Evidence `scope` model (run/architecture/section/decision — the represented retrieval edges), `renderPlanningProtocol` (L0 semantics — now an assembler input).
- **Single-authority risk (brief §3):** the old `index.ts` transform resolved active-section/synthesis projections inline and injected the legacy renderer. This path was REPLACED; the renderer's fragment functions are shared with the assembler so the L0 semantics cannot diverge, and the legacy composition survives only as a pinned embedder view (never injected in production — pinned by test).

## Context Assembly Authority

ONE production path: `assemblePlanningContext(state, options)` in `src/context/assembler.ts`, over `PlanningContextState` from `capturePlanningContextState(planID)` (a new read-only method on the `PlanStore` boundary; `InMemoryPlanStore` reads are trivially consistent, `DurablePlanStore` performs ONE `refreshFromDisk` then reads its hydrated maps — no per-read refresh, no writer lock).

The pipeline is exactly the frozen §13 pipeline: Memory Store (capture) → Structural Retrieval (fragment builders over represented relationships) → Context Projection (deterministic per-artifact projections) → Budget Manager (P0-P3 degradation) → Renderer (layered block) → OpenCode model request.

`index.ts`'s transform is the only injection site; it pushes the assembled block and emits the structured trace. `renderPlanningProtocol` remains exported (embedder/test view) but is NOT called by the production path (pinned by `test/context-integration.test.ts` "no legacy duplicate fragment").

## Snapshot-consistent Read Boundary

`capturePlanningContextState` returns one immutable `PlanningContextState`:

- run header (working state: goal/constraints/questions/conflicts/pointers),
- HEAD commit + HEAD Snapshot,
- current Architecture / current Section roots / current SectionRevisions / current Decision revisions — resolved through the HEAD Snapshot's pointers (absence is meaningful, never backfilled),
- current Evidence state (newest revision per id),
- proposals, the current synthesis identity set (latest input → its latest manifest → the current report for that exact identity → current audit → current candidate → current final Proposal), committed FinalPlan, ExecutionHandoff.

A test pins the coherence property: two assemblies from ONE captured view are byte-identical even when the store mutates between them (brief §5).

## Context Fragment Model

The internal model (never exposed as Plan Memory) is the brief §7 shape adapted to the real type system: `ContextFragment { id, layer, priority, reason, reasons[], ref?, orderKey, desiredDetail, minimumDetail, droppable, variants[] }` with `ContextProjectionVariant { level, text }`. Every fragment carries one variant per level from desired down to minimum, so budget degradation switches between complete deterministic texts — never truncation.

## Projection Levels

`src/context/projections.ts` is the deterministic projection registry (pure functions of approved artifacts; no clock, no randomness, no model):

- **identity** — exact ref + minimal label/status (e.g. `SEC-005 [approved] validation=valid contract=SEC-005@1`, `DEC-002@2 [approved] title`, `EVD-037@2`).
- **summary** — canonical compact representation: for SectionRevisions this IS the approved `projection.compact` verbatim (stable §17 projection, never re-summarized); for Architecture the deterministic structured compact (summary/components/boundaries/data flows/principles); for Evidence the compact `EVD-###@n [freshness/confidence/criticality] + claim + source` form of §28/§41.
- **relevant** — structurally relevant fields for the current scope (revision: problem + dependencies + decisions/questions/impacts on top of the approved compact; decision: + rationale/scope; contract renderings verbatim).
- **full** — the complete approved structured artifact within the model-visible safe representation (SectionRevision full adds design/interfaces/invariants/failure modes; Architecture full adds carried unresolved questions).

The levels materially differ per artifact (pinned by tests); the Section root's content ceiling is `relevant` because full design content lives in the SectionRevision artifact — a separate fragment — rather than padded duplication.

## L0 Protocol

`protocol.ts` now exposes `renderL0ProtocolFragment` — the assembler's L0 content: the ten protocol rules + stage guidance + lifecycle boundary lines. A `compact` mode omits the store-derived DATA lines (active-section identity, per-dependency contract availability, checkpoint/hash identities): L1 and L3 carry that content, so L0 stays compact and duplication-free (brief §12). The full guidance (with data lines) remains in the legacy composition, byte-identical to v0.12 (all pre-R1 pins pass unchanged).

## L1 Run State

The L1 capsule is rendered automatically from exact current state: plan, lifecycle, stage, derived workflow substate, active work, head_commit, head_snapshot, architecture ref (+ status), decomposition provenance (`section_dag_decomposed_from`, or `none (no current decomposition)` post-amendment), section progress counts (total/approved/active_or_reopened/pending), blocking question/conflict counts WITH exact ids, open counts. Nothing is inferred from conversation.

## L2 Global Committed Memory

Automatic on every planning inference: the goal (`Goal: …`), all `severity=hard ∧ status=active` constraints (exact id + statement — the non-droppable minimum), and the compact approved Architecture projection. Soft constraints are NOT P0 — they enter as P3 droppable supporting context. No candidate/uncommitted constraint is ever included.

**The §14/§16 resolution (brief §16):** the Architecture compact is a P2 fragment whose minimum representation is its required compact projection and whose `droppable=false`. P2 governs compression/order decisions; it can downgrade nothing here (minimum = summary) and can never remove the fragment. P2 does NOT imply this required L2 fragment may disappear — implemented, pinned by tests under extreme budget pressure, and documented in protocol §7.17. When the Architecture is itself the active scope, the same fragment upgrades to relevant/full (one fragment — no duplicate rendering) with merged retrieval reasons.

## L3 Active Scope

Structural retrieval by workflow scope — no model read request required for any of it:

- **Section work (`activeWork = SectionRef`):** the active Section root (identity P0), the exact current approved/current revision (desired relevant; approved compact + problem + dependencies + decisions + questions + impacts), direct dependencies with EXACT approved revision + EXACT SectionContract (P1, contract minimum), transitive dependencies over the committed DAG (BFS, deduped, identity-level at P2, never full design), section-scoped decisions (exact HEAD-bound revisions — the SectionRevision's decision ids resolved through the snapshot's pointer map, no latest-by-ID substitution), inherited dependency decisions (direct contracts P1, transitive contracts P2, deduped by exact ref with merged reasons), relevant interfaces (active revision + direct contracts, smallest form), scope-relevant questions/conflicts (blocking P0 everywhere; non-blocking only when structurally scoped), and the deterministic downstream impact summary (direct + transitive affected, status/validation only, P2).
- **Architecture work (architecture stage / R1b remediation / decomposition-needed):** the Architecture fragment upgrades to full per budget, `basedOn` decisions are included at P1 (exact refs, fail-closed if unresolvable), architecture-scoped questions/conflicts apply the blocking rule, architecture evidence rides P2, and the remediation guidance rides L0. NO historical/invalidated Section DAG can enter current context — after an R1 amendment `run.sections` is structurally empty; old sections remain exact-readable only through `plan_memory`.
- **Synthesis:** the derived-artifact identity capsule — SynthesisInput ref/hash/base/staleness, manifest ref/revision/hash, current ValidationReport ref/result/hash, EvidenceAudit ref/result, FinalPlanCandidate ref/revision/hash + head-currency, current Final Proposal identity/status. Compact identities, never full dumps; full exact reads remain `plan_memory`'s job.
- **Discovery / before artifacts:** L3 is intentionally sparse (blockers + structurally relevant items only); nothing is fabricated.

## L4 Working Context

Explicitly separated and labeled: the current ready/awaiting Proposal (P1, reason `current_proposal`, exact hash visible) rendered under `=== L4 CURRENT WORKING CONTEXT ===` with a working-state banner and, when awaiting approval, an explicit FROZEN-NOT-COMMITTED marker. Candidate question resolutions render as working state. Rejected/superseded proposals never appear; after a commit the next assembly presents the new committed state (transition pinned by test). The OpenCode conversation is never duplicated.

## L5 Operations

Rendered from `getCapabilities` with the same synthesis-substate context derivation the tools use — one authority, no second matrix (the checklist text is the shared renderer from `protocol.ts`). Assembly mode `handoff-status` (handoff_pending runs) keeps the read-only checklist. L5 is informational; server-side authorization is unchanged (pinned: a capability refused by the matrix throws even though the checklist names it).

## Structural Dependency Retrieval

Deterministic graph walks over the CURRENT Section DAG only (`run.sections` order canonical): direct dependencies = `active.dependencies` (fail-closed if a named root is not committed); transitive = BFS closure excluding direct (stable sort, dedup); downstream = reverse adjacency (direct + transitive, status/validation only). Historical/invalidated section sets (R1 amendments) are unreachable by construction.

## Evidence Retrieval Priorities

`spec §28` realized with represented edges only:

- **P0 `blocking_evidence`:** for each open blocking question, its scope artifact → exact decisions (architecture `basedOn`; section revision decisions) → evidence refs; for each open blocking conflict, its refs → decisions the same way. No relationship is invented; blockers with no represented edge contribute nothing.
- **P1 `active_decision_evidence` / `active_section_evidence`:** evidence referenced by the active-scope decisions; evidence with `scope = {kind:"section", sectionID: active}` — the scope kind the model actually represents (the brief's "if representable" clause is satisfied; nothing faked).
- **P2 `dependency_evidence` / `architecture_evidence`:** evidence scoped to direct/transitive dependency sections; architecture-scoped evidence; evidence of `basedOn` decisions.
- **P3:** run-scoped supplementary evidence — the first Evidence class dropped under pressure.
- Dedup by exact ref (`id@revision`); effective priority = highest of all retrieval reasons; the trace preserves every reason. Automatic context always reflects the CURRENT evidence state (historical revisions stay `plan_memory`-only); stale/needs_validation records render their exact state. A semantically-similar-but-unlinked record is never retrieved (pinned: the lookalike test).

## Budget Manager

`src/context/budget.ts`: deterministic, provider-neutral, never model-driven.

- **Estimator** (audited: no host tokenizer available): `estimateTokens(text) = ceil(asciiUnits/4) + nonAsciiUnits` — pure, process-stable, UTF-8-safe, conservative (documented as budget estimates, not billing tokens). Formula pinned by tests across ASCII/CJK/multiline.
- **Default budget:** 12,000 estimated tokens — conservative, documented, adapter-configurable via `ULTRA_PLAN_CONTEXT_BUDGET_TOKENS` (invalid values fall back to the default; never a load error). `ULTRA_PLAN_CONTEXT_OVERFLOW` selects `render` (default) or `fail`. Core hardcodes no provider window. The budget applies ONLY to the assembled Ultra Plan context — never conversation, tool schemas, host prompts, or responses.
- **Degradation:** a fixed-order action loop exactly following brief §48 — P3 downgrade steps (full→relevant→summary→identity, never below a fragment's minimum), then droppable-P3 drops, then P2, then P1 (only explicitly droppable). P0 is never dropped nor degraded below minimum; the required L2 Architecture compact survives by construction. Tie-breaking is the canonical (layer, priority, orderKey) order — repeated runs make identical choices (pinned).
- **Overflow:** when required minimum exceeds the budget, remaining droppable fragments yield (P3→P2→P1) and ALL required minimum content renders with `trace.overBudget=true` plus a structured `ultraplan.context.warning`; `overflow=fail` throws `context_budget_exceeded` instead (deterministic both ways, both pinned).

## Token Estimation

See Budget Manager. The exact formula, its conservatism rationale (CJK ≈ 1-2 real tokens per code point vs. 1 charged), and its limitations (estimates, not provider billing-token counts; no host tokenizer exists to verify against) are documented in code and in protocol §7.17. No model-specific tokenizer subsystem was added.

## Required-content Overflow Semantics

P0 and required L2 content are never silently truncated or dropped. The preferred `context_budget_exceeded`-before-inference behavior exists behind `ULTRA_PLAN_CONTEXT_OVERFLOW=fail`; the DEFAULT is render-complete + flag + warn because the OpenCode transform's throw semantics are unverified — a throwing transform could fail unrelated inference rather than just the planning turn. This is the documented host limitation (brief §17's fallback branch), surfaced rather than hidden; both paths are deterministic and pinned.

## ContextTrace / Observability

The frozen §19 concept is implemented and closed (Invariant 30's equivalent-observability obligation is now met by an actual trace record). Documented adaptations to the real type system: `included[].ref` is optional (L0/L1/L5 and the synthesis capsule are structural fragments; `fragmentId` always present), and `RetrievalReason` gains the documented additions (`protocol`, `run_state`, `goal`, `capabilities`, `architecture_compact`; evidence reasons `blocking_evidence`, `active_decision_evidence`, `active_section_evidence`, `architecture_evidence`, `dependency_evidence`). Included entries record ref/layer/priority/projection/desiredDetail/reasons/estimatedTokens/budgetDecision; exclusions carry stable machine reasons (`budget_dropped_p3` …, `resolved_conflict_not_current` — resolved conflicts are excluded observably, never rendered as blocking). `budget`, `overBudget`, `totalTokens` (= `estimateTokens(rendered)`, pinned) are recorded.

**Deterministic trace identity (§52):** `TRACE-<sha256-12>` over the assembly decisions (PlanID, HEAD, stage, activeWork, budget, included/excluded fragment decisions) — no allocator, no clock, assembly stays read-only. **Not Plan Memory (§53):** never persisted through PlanCommit, never HEAD-moving; observability is the structured log plus a bounded ephemeral latest-trace cache (`recordLatestTrace`/`getLatestContextTrace`) that is test-visible and non-authoritative. **Trace failure cannot change context correctness (§89):** the rendered block is independent of tracing and the production hook wraps logging best-effort (pinned: a throwing logging backend leaves the injection complete).

## OpenCode System-transform Integration

`experimental.chat.system.transform` (verified host surface) is the single injection site: one snapshot-consistent capture → one assembly → ONE `<ULTRA_PLAN_CONTEXT …>` block pushed into `output.system`, with the structured trace logged on `ultraplan.context.trace` (single-line JSON; ids/refs/levels/reasons/tokens only — never prompt content). No duplicate legacy fragment is injected (pinned). Active runs receive the full L0-L5 planning block; `handoff_pending` receives the minimal non-authoritative handoff-status context (L0 boundary + L1 + read-only L5, mode `handoff-status`); aborted/completed runs receive nothing (`findActiveRunBySession` returns no active run — §65/§67 hold, Build's ExecutionHandoff boundary is untouched, and R2 re-enables nothing in Build).

## Compaction Independence

- **Deterministic side (§68/§69/§100):** the full L0-L5 context assembles from `capturePlanningContextState` alone — no conversation input exists anywhere in the pipeline. Restart proof: a durable store is seeded, assembled, CLOSED, and a brand-new `DurablePlanStore` instance over the same file re-assembles to the BYTE-IDENTICAL rendered context and an identical trace (same fragment set, refs, projection levels). Evidence/blocker changes WITHOUT HEAD movement are reflected by the next assembly (HEAD-only caching would be wrong — no assembler cache exists at all, per brief §90/§91/§92).
- **Live side (§70/§71):** the audited real primitive is `POST /session/{id}/summarize` (plus the `session.compacted` event and the two compaction plugin hooks — no mechanism was invented). The live smoke triggers REAL host compaction on a session with meaningful durable planning state, waits for the compaction message in the real session history, and proves from the NEXT planning inference's trace: same PlanID, same stage, same activeWork, and L0 protocol + L1 run state + L2 goal + L5 operations all reconstructed. Conversation detail may differ; committed planning context does not.

## Live OpenCode Compaction Validation

`scripts/opencode-context-smoke.mjs` (npm run `smoke:opencode-context`), run against a real `opencode serve` + real model:

- §75 system-transform live proof: the assembler's structured trace is emitted by the actual transform hook during real planning requests — closing the exit review's "S+T only" gap for context injection.
- §72/§73 proof discipline: the model is never asked to repeat its prompt; the smoke parses the trace diagnostic (whose key set is pinned — no prompt content).
- §76 live L2: the goal fragment (user-authored unique marker) is included automatically, with no `plan_memory` call.
- §71 live compaction: summarize → compaction message → next inference's trace carries the same PlanID/stage/authority and the required layers (results below).

Headless boundary (standing and honest, unchanged from every prior phase): interactive approvals cannot be given headlessly, so a committed ARCH and an active Section with contracts cannot be seeded in a live run; the constraint/ARCH L2 fragments and section active-scope retrieval (§77) are pinned at S+T level by the deterministic suite (same fragment code paths the live trace exercises for goal/protocol/run-state/operations). No live evidence is faked anywhere.

## Evidence-state Without HEAD

Evidence, blockers, and working state can change without HEAD moving; therefore there is NO assembler cache keyed by anything (brief §90's "prefer no cache"). Every assembly captures fresh coherent state. Pinned: same HEAD + a new Evidence revision → next context shows the new revision; same HEAD + a resolved blocker → next context reflects it. (If caching is ever introduced, the brief's binding requirements are recorded here and in protocol §7.17.)

## Determinism Tests

`test/context-architecture.test.ts` (46 tests) + `test/context-integration.test.ts` (22 tests) + fixtures (`test/context-helpers.ts`), mapped to brief §97's minimum list — all 68 enumerated cases are covered (several share one test where the same assertion proves two enumerated items), plus implementation-specific cases discovered in the audit (R1 reload regression, immutable-view stability, legacy renderer byte-compat, trace-log shape):

1-2 identical state → identical rendered context and trace; 3 coherent read binds one HEAD; 4 L0 always included; 5 L1 exact PlanID/stage/HEAD/blocker ids; 6 goal automatic; 7 hard constraints automatic P0; 8 soft constraints not P0 (P3 droppable); 9 Architecture compact automatic; 10 (45) required compact survives extreme pressure; 11 active Section identity P0; 12 active revision relevant projection; 13 direct dependency exact contract; 14 transitive dependency compressed; 15 section-scoped decision exact ref; 16 inherited dependency decisions with dedup/priority merge; 17 relevant interfaces; 18 blocking questions P0; 19 non-blocking filtered by scope; 20 blocking conflicts P0; 21 resolved conflicts never current (observable exclusion); 22 downstream impact deterministic; 23 current Proposal L4/P1 with exact hash; 24 rejected Proposal absent; 25 committed-vs-working labels explicit; 26 L5 from getCapabilities; 27 L5 cannot grant authority (server-side refusal pinned); 28 architecture-remediation context; 29 decomposition-needed uses the new ARCH; 30 (86/99) invalidated old DAG never current; 31 synthesis identities reconstruct; 32-36 evidence P0/P1/P2/P3 paths + dedup + priority merge; 37 (85) unlinked lookalike excluded; 38 stale evidence shown stale; 39 same HEAD + evidence change reflected; 40 same HEAD + blocker change reflected; 41 historical revision not auto-included; 42 P3 drops first; 43 P2 before protected P1 (exact deterministic decision sequence pinned at two budgets); 44 P0 never dropped; 45 required L2 Architecture retained; 46 over-budget behavior deterministic (render+flag; fail-closed pinned separately); 47 projection downgrade switches exact variants; 48 no mid-field truncation; 49 stable tie-breaking; 50 UTF-8 estimator deterministic/conservative; 51-55 trace records refs/reasons/levels/exclusions and total matches estimator; 56 trace independence of context correctness; 57 restart byte-identical reconstruction (real close/reopen); 58 no conversation history required (entire suite); 59 transform injects assembler output only (no legacy fragment); 60-62 transform emits live trace with L2 + direct_dependency reasons (harness-level; fully live in the smoke); 63 compaction/context-reset reconstruction (deterministic restart + live summarize); 64 abort → no planning context; 65 completed → no planning-mutation context; 66/67/68 all R1, 2J, and pre-existing tests remain green (full suite).

**§98 primary integration case:** the dense fixture (goal; hard+soft constraints; ARCH@2; active SEC-004 with SEC-005 direct/SEC-006 transitive/SEC-007 downstream; contracts; section + inherited decisions; blocking/non-blocking questions; blocking/warning/resolved conflicts; P0-P3 evidence + unlinked lookalike; current ready Proposal) assembled under a constrained realistic budget asserts every layer, every priority, correct evidence classes, working-state labeling, deterministic degradation, and a trace that explains every inclusion/exclusion — then repeats from a fresh store with identical output. **§99 primary R1→R2 case:** post-amendment state (ARCH@2, `sections=[]`, provenance cleared) assembles with decomposition-needed substate and NO old DAG; old artifacts remain exact-readable; then a new decomposition yields a context containing only the new DAG with provenance re-bound. **§100 deterministic side:** covered by the restart test; live side by the smoke.

## Budget Tests

See items 42-50 above: P0 preservation under tiny budgets; the exact deterministic degradation sequence at two pinned budgets (P3 drops → droppable-P2 drops before any P1 downgrade → P1 downgrade at summary/identity minimums → over-budget render of the full required minimum); projection-level switches verified against the exact variant texts (no substring slices); tie-break stability across runs; estimator determinism/UTF-8; overflow fail-closed error code.

## Retrieval Tests

See items 11-22 (section scope) and 32-41 (evidence priorities/dedup/leakage/staleness/fidelity) with the §85 unlinked-lookalike and §86 historical-exclusion proofs.

## Live Runtime Tests

`npm run smoke:opencode-context` — **17/17 checks** against a real `opencode serve` + real model:

- server + plugin load; session; /ultra-plan with the unique user-authored goal marker;
- §75: the assembler's structured trace emitted by the actual transform hook during real planning requests (key set pinned — no prompt content);
- §76: L0/L1/L2-goal/L5 fragments automatic in the live trace (no `plan_memory` call);
- discovery→architecture moved by a live model invocation; the next trace reflects the new stage;
- §70/§71: REAL compaction triggered via `POST /session/{id}/summarize`, the compaction part observed in the real session history, and the next planning inference's trace proves: same PlanID, same stage, same activeWork, and L0 protocol + L1 run state + L2 goal + L5 operations reconstructed from durable authority.

The pre-existing smokes remain green: `smoke:opencode` 37/37, `smoke:opencode-handoff` 16/16 (both first-run, in isolation).

Headless boundary (standing and honest, unchanged from every prior phase): interactive approvals cannot be given headlessly, so a committed ARCH and an active Section with contracts cannot be seeded in a live run; the constraint/ARCH L2 fragments and section active-scope retrieval (§77) are pinned at S+T level by the deterministic suite (same fragment code paths the live trace exercises for goal/protocol/run-state/operations). No live evidence is faked anywhere.

## Verification Results

True producer exit codes; smokes run IN ISOLATION from builds/tests (brief §101):

```text
npm run typecheck -w @switchboard/opencode   exit 0
npm run lint       -w @switchboard/opencode  exit 0
npm test           -w @switchboard/opencode  exit 0   634/634 tests, 23 files
npm run build      -w @switchboard/opencode  exit 0
npm run smoke:opencode-context               exit 0   17/17 checks
npm run smoke:opencode                       exit 0   37/37 checks (first run)
npm run smoke:opencode-handoff               exit 0   16/16 checks (first run)
npm run typecheck                            exit 0
npm run lint                                 exit 0
npm test                                     exit 0   root aggregate, all workspaces
npm run build                                exit 0
```

First-run results and retries disclosed (brief §101 — nothing masked):

- All deterministic checks (typecheck/lint/test/build, scoped and root) passed on the first run of the final state; no transient failures occurred.
- The context smoke reached 17/17 on its final execution after ten earlier executions whose failures were smoke-HARNESS detection defects (the implementation itself was unchanged and green throughout; the harness defects were each fixed and disclosed): (1) the compaction marker was probed as a message-info type instead of the actual `CompactionPart` part type; (2) the host logger does not reliably terminate lines with newlines — the trace JSON could be split across stream chunks or concatenated with host log text and missed by line-based parsing (fixed with a line-buffered capture plus a brace-balanced extractor over the raw stream including the unflushed buffer); (3) the synchronous `POST /message` returns only after the assistant turn completes, so the post-compaction trace baseline was captured after the very traces it should precede (fixed by capturing the baseline before the POST). Separately, the discovery→architecture leg failed once on free-tier model cooperation (the model skipped the tool call) — the smoke now retries the prompt, and the leg passed on every subsequent run; and one non-scoring NOTE was introduced for "session idle" (a host scheduling observation that never fires within the wait under free-tier retry/backoff — the §71 assertions are the compaction gate, so this is deliberately not scored).

## Deviations / Architecture Amendment Candidates

No frozen-architecture text was modified. Interpretations, findings, and candidates:

- **R1 REGRESSION FOUND AND FIXED (resolved-conflict durable reload):** R2's restart test exposed a genuine R1 defect — the durable load validation for resolved conflicts (`document.ts`) read the committed families at the wrong nesting level (`doc.committed["decisions"]` instead of the per-plan `doc.committed[planID].decisions`), so ANY durable store carrying a resolved conflict bound to a decision or the Architecture failed `store_corrupt` on reload. R1's own tests had not caught it because the false-positive path also throws `store_corrupt` (tamper tests passed for the wrong reason) and no R1 test reloaded a legitimately resolved state. Fixed (per-plan family binding) and pinned by a dedicated regression test that builds a legal open → commit → resolved sequence and RELOADS it clean across a real close/reopen. This is an R1 remediation repair, not a scope addition.
- **(AM-13, candidate)** Spec §14/§16 tension on the Architecture compact resolved as documented: required non-droppable L2 fragment whose priority is P2 for compression/order decisions — P2 never implies removal. Recorded in protocol §7.17; a v0.1.1 editorial note in §16 is proposed.
- **(AM-14, candidate)** §19's `ContextTrace.included[].ref` cannot be required in the real type system (structural L0/L1/L5 fragments and the derived synthesis capsule have no MemoryRef); `fragmentId` is always present instead, `ref` optional. Same adaptation for the documented reason-vocabulary additions. Editorial.
- **(AM-15, candidate)** §28's "Evidence scoped directly to active Section" is representable in the current data model (`EvidenceScope.section`) and was implemented as such; the brief's representable-only rule is honored. Editorial note proposed.
- **Overflow default:** `render` is default and `fail` opt-in — the OpenCode transform's throw semantics are unverified, so the safe fallback branch of the brief is the default. This is an implementation-layer interpretation, not an architecture deviation.
- **Legacy renderer retained:** `renderPlanningProtocol` remains exported for embedders with byte-identical output, but is NOT a production context path (single-authority rule); pinned so it can never silently re-enter the transform.

## R2 Exit Status

**COMPLETE — B-D resolved.** Structural Retrieval exists; projection levels exist and materially differ; L0-L5 assemble automatically; L2 goal/hard-constraints/Architecture are automatic; L3 active-scope memory is automatic; Evidence retrieval follows structural P0-P3 priorities; the Budget Manager performs deterministic priority-aware degradation with P0 never silently dropped; required minimum context has explicit overflow semantics; retrieval decisions are observable (trace + structured log); assembly is deterministic, read-only, and reconstructed from durable authority without conversation history; R1 amendment/decomposition semantics compose correctly with context reconstruction (§99); and the real OpenCode runtime proves the system-transform executes the assembler plus the strongest legitimate compaction proof — a REAL host summarize on a live session with post-compaction reconstruction asserted from the actual trace.

## Exit-review Re-run Readiness

R1 + R2 are both complete; the v0.1 Architecture Exit Review can now be re-run against the post-R1/post-R2 implementation, re-dispositioning B-A, B-B, B-C, and B-D. Expected disposition per the original review: **PASS WITH DOCUMENTED NON-BLOCKING DEFERRALS** (the deferred set: ContextTrace-adjacent optional items now closed; remaining deferrals are the explicitly optional/future items — autonomous evidence-freshness automation, planning-model tier policy, Build tracking/out-of-scope architecture §36 items). Release readiness is decided by that re-review, not by this report.

---

## STOP

Per the R2 brief §104: R2 is complete; no further feature phase is started; the frozen architecture remains unmodified. The next task is the v0.1 Architecture Exit Review — Re-run, using the exit review and traceability documents as baseline and re-dispositioning B-A/B-B/B-C/B-D against the post-R1/post-R2 implementation.
