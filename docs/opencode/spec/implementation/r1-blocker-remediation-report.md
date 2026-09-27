# R1 Blocker Remediation Report

**Phase:** R1 — Blocker Cure, Deadlock Freedom & Architecture Remediation
**Scope:** Exit-review blockers B-A (conflict resolution lifecycle), B-B (synthesis blocker-cure gap), B-C (architecture-level remediation) + the explicit abort decision. B-D (Context Architecture) is explicitly NOT part of R1 — it is R2.
**Baseline:** `v0.1-architecture-exit-review.md` (disposition: NOT READY — ARCHITECTURE REMEDIATION REQUIRED) + the frozen architecture (unmodified — zero diffs) + protocol v0.11.
**Date:** 2026-09-26

---

## Exit-review Baseline

The v0.1 Exit Review proved the authority chain (30/30 Core Invariants satisfied, zero mutation bypasses, comprehensive crash/concurrency proof) and identified four release blockers. R1 implements the smallest coherent remediation for three of them plus the abort decision, under the governing invariant: **no reachable active planning state may become permanently wedged by a blocker the Harness itself allows to be created.**

## R1a Blocker Lifecycle

- **§8 raise rule:** `raise_conflict` refuses a `severity: "blocking"` conflict whose refs identify no Architecture/Section/Decision (`invalid_scope`) — the Harness can never create a blocker with no sanctioned cure. Warning conflicts stay unrestricted; historical conflicts are never rewritten; all refs still resolve against run state (`unknown_reference`).
- **§10-§14 blocker-driven reopens:** `request_reopen` gains the closed reasons `blocking_question` and `blocking_conflict`. The model names the blocker only; the Harness resolves the exact remediation target — a question's own scope (Section, or Architecture in R1b), or a conflict's refs in a documented first-match order (ArchitectureRef → Architecture; else SectionRef → that Section; else DecisionRef → the decision's scope with canonical-order section selection). Non-blocking/resolved blockers are refused with precise errors. No ValidationReport is required, consulted, or fabricated; the blocker stays OPEN through the reopen (only the later user-approved corrective Proposal cures it).
- **§16 abort:** `ultraplan_request_abort` (working_state, zero authority-bearing arguments) → REAL one-shot `ToolContext.ask` (`always: []`) → narrow `abortRun` store transition (active + stage ∈ discovery/architecture/detail/synthesis, else `abort_not_allowed`): `lifecycle = aborted` (terminal), activeWork cleared, one `run.lifecycle_changed` event. No FinalPlan, no handoff, no Build turn, no PlanCommit, no HEAD movement, nothing erased. Deny leaves the run untouched. Abort is an escape hatch, never a blocker-resolution substitute (§17).

## Conflict Resolution Contract

The closed `resolve_conflict` change (design_checkpoint/amendment proposals, architecture/detail stages only) is the ONLY `open → resolved` path. The resolution `{action, ref}` is Harness-derived, never model-authored:

- `revise_proposal` → the carrying proposal's own exact ref (id assigned BEFORE change resolution so the self-binding is exact); valid only when the conflict's refs are addressed by the proposal's scope or another change (pure ref matching, validated as a freeze post-pass).
- `amend_decision` → the exact resulting DecisionRef of a paired `amend_decision` change EARLIER in the same proposal superseding a Decision the conflict names.
- `amend_architecture` → the exact resulting ARCH@n+1 of the paired `amend_architecture` change.

The engine re-validates every binding against STAGED state (the bound record must exist in the transaction result or committed state; wrong-proposal self-binding refused) and enforces one resolution per conflict per proposal. Resolutions are immutable historical state; `PlanCommit.changes` carries the audit trail (§39 — no new event types; the conflict record + commit remain authoritative).

## Conflict Self-block Exception

The `conflict_blocking` gate now exempts the conflicts explicitly named by sanctioned remediation changes in THIS exact proposal: `resolve_conflict(C)` (staged `resolved` before the gate runs) and blocker-driven reopen reasons bound to C. Unrelated blocking conflicts still block exactly as before. No `ignore_conflict`/`allow_blocked_commit`/`force` flag exists anywhere.

## Synthesis Blocker Reopen

B-B is cured WITHOUT granting `prepare_proposal` in synthesis (§9 — synthesis stays projection-oriented): `request_reopen` is granted in ALL SEVEN synthesis substates for the blocker-driven reasons, and the section/architecture reopen admission resolves everything authoritative. `request_reopen` is additionally granted in `detail/decomposition-needed` (architecture blockers must be curable before any Section exists). The semantic_validation reason is unchanged; a clean report still refuses section reopens (`reopen_reason_invalid`).

## Abort Decision

IMPLEMENTED (preferred option of brief §16). `ultraplan_request_abort` is a registered model-visible tool with a REAL user confirmation; `abortRun` is a durable lock-wrapped store operation; the `aborted` lifecycle is now reachable and terminal; `/ultra-plan` after abort requires a fresh admission and creates a NEW run. Durable load validation fails closed on an aborted run carrying activeWork or stage=final. Rationale: the frozen architecture names `aborted` in the lifecycle union and terminal semantics; without a writer, B-B wedges were unrecoverable.

## R1a Deadlock-freedom Proof

`test/r1-blocker-remediation.test.ts` ("R1 §41") drives the cure admission for every reachable blocked state:

- discovery/blocking-question → the sanctioned discovery → architecture transition is admitted (resolve_question becomes preparable in architecture);
- architecture/blocking-conflict → the remediation proposal (paired decision change + resolve_conflict) is prepared;
- synthesis (no-input) blocking question → the blocker-driven reopen prepares the exact Section reopen;
- the §41 matrix test pins `request_reopen` + `request_abort` grants across ALL SEVEN synthesis substates (and `prepare_proposal` withheld everywhere in synthesis);
- the full-cure COMMITS are proven in the dedicated tests: §42 (conflict self-block commit), §43/§44 (question/conflict reopen → detail → corrective cure), §45 (architecture finding → reopen → amendment → re-decomposition), §48 (abort).

Evidence level: deterministic integration tests (T), plus crash-window child-process proofs (C) for every new publication.

## R1b Architecture Reopen

`reopen_architecture` (amendment proposals only, scoped to the exact ARCH@n) is admitted from synthesis or detail for an Architecture-scoped validation finding (legacy `requestReopen` without sectionID), a blocking architecture-scoped question, or a blocking conflict whose refs identify the Architecture. The commit re-validates everything the freeze validated (report identity currency, blocker openness/blocking, scope agreement) — hostile direct engine calls fail closed. Commit effects (§20): stage → detail, activeWork → `{type: "architecture"}`; ARCH@n stays approved and immutable; NO new revision; Sections unchanged; old derived artifacts go stale via the existing identity rules. `reopen_target_unsupported` no longer fires for genuinely architecture-scoped blockers — B-C's dead end is closed.

## Architecture Amendment Contract

`ultraplan_prepare_architecture_amendment` (proposal_intent, remediation substate ONLY) takes the closed Architecture schema (summary/components/boundaries/dataFlows/principles/unresolvedQuestionIDs/basedOn — references resolved against committed state at freeze) plus optional `resolveQuestionIDs` / `resolveConflictIDs`. The Harness assigns everything authoritative: base = exact current ARCH@n, result = ARCH@n+1 (frozen "approved", written VERBATIM), every resolution ref. `amend_architecture` staging enforces: base = current ARCH, contiguous revision, approved status, remediation substate, ARCH@n+1 not already present. The engine's `resolve_conflict` case verifies the amendment pairing against staged state. The generic `prepare_proposal` vocabulary REFUSES all four reserved kinds (`reopen_architecture`, `amend_architecture`, `reopen_section`, `add_final_plan` — pinned by test).

## Architecture / Section-set Provenance

`PlanningRun.sectionDecompositionArchitecture?: ArchitectureRef` (§50) + `SnapshotState.sectionDecompositionArchitectureRevision?: number` (§51) — set by the decomposition commit (the proposal's exact ARCH scope), CLEARED by the amendment commit (explicit value assignment so the prior key cannot survive), absent on pre-R1 runs (legacy tolerance). Durable load validation (§49): present ⇒ sections non-empty ⇒ equals the run's current ARCH revision, else `store_corrupt`. This makes "current DAG decomposed from current ARCH" provable from data, never timestamps.

## Section DAG Invalidation

The amend_architecture commit conservatively invalidates (§26): every currently-current root stays durable with `validation = needs_review` (status untouched — approved roots remain approved history); `run.sections → []`; activeWork cleared; provenance cleared; stage stays detail. The engine staging is part of the amendment transaction — no post-commit saveRun, no partial reset (§35: a failed amendment leaves architecture pointer, Section set, focus, stage, blockers, and HEAD exactly unchanged with the Approval durable — proven by the §35 drift test).

## Re-decomposition Semantics

After the amendment the derived substate is `detail/decomposition-needed` (§37): `prepare_section_decomposition` is restored, `prepare_architecture_amendment` is withheld until another sanctioned reopen. The SAME decomposition workflow applies against ARCH@n+1 (§28 — no new tool, no DAG diffing). The durable allocator now continues the run's HISTORICAL SEC sequence (§30): the sequence base is the committed Section registry, so post-amendment decomposition allocates SEC-004… — the invalidated SEC-001…003 are never recycled (uncommitted allocations remain re-issuable). Fresh-ID allocation is pinned by the §45 test.

## Historical Artifact Preservation

§29 holds: old Section roots (marked needs_review), all SectionRevisions and contracts, ARCH@n, Snapshots, and all derived artifacts remain exact-readable through `plan_memory` — the §45 test reads ARCH@1 and SEC-001 after the amendment. Nothing is deleted or resolved as current; stale SynthesisInput/Manifest/ValidationReport/Audit/Candidate go historical through the existing HEAD-identity rules (§31), and the only path back to finalization is the full pipeline on the new identity (§32).

## Capability Matrix Changes

Fourth detail substate `detail/architecture-remediation` (record_question, propose_question_resolution, promote_evidence, prepare_architecture_amendment — reads and request_abort via the active-stage grant). Deliberately absent: raise_conflict (a NEW conflict during remediation could be unremediable), prepare_proposal, checkpoint/focus/completion/decomposition. `request_abort` granted in every active stage column, never final/handoff_pending/terminal. `request_reopen` granted in all synthesis substates + decomposition-needed. `ultraplan_request_abort` (working_state) and `ultraplan_prepare_architecture_amendment` (proposal_intent) registered in the contract seeds; `ultraplan_resolve_conflict` plus the six §38 direct-mutation names added to FORBIDDEN_TOOL_NAMES. Matrix pinned by `test/capabilities.test.ts` (all four detail substates + seven synthesis substates + stage rows).

## Durable Representation

Additive with STORE_SCHEMA_VERSION still 1: `sectionDecompositionArchitecture` on the run record and `sectionDecompositionArchitectureRevision` in snapshot state (absence = legacy, meaningful, never backfilled); resolved Conflicts live in the run record (working-state array, mutated ONLY by approved resolve_conflict staging). New WorkRef variant `{type: "architecture"}` validated in run + snapshot load checks. Fail-closed load validation added (§49): resolved conflict without valid resolution / missing bound decision / missing bound ARCH / missing bound proposal → `store_corrupt`; provenance contradictions → `store_corrupt`; architecture-remediation focus without the exact committed ARCH or outside detail → `store_corrupt`; aborted run at stage=final or carrying activeWork → `store_corrupt`. No repair, ever.

## Crash Recovery

Four new real child-process windows (§47) via `scripts/crash-probe.mjs` modes `architecture-reopen` and `architecture-amendment` (ARCH-scoped findings validator; the amendment mode commits the reopen cleanly first so the seam sits exactly on the amendment publication):

| Window | Pre-persist | Post-persist |
|---|---|---|
| reopen_architecture | zero partial state (synthesis, ARCH@1, 3 sections, HEAD COMMIT-008), Approval durable, retry commits once (COMMIT-009) | exact remediation substate (detail + activeWork architecture), retry idempotent |
| amend_architecture | remediation substate intact + Approval durable, retry commits ARCH@2 once (COMMIT-010, sections reset) | ARCH@2 + invalidated DAG (SEC-001 approved/needs_review), head snapshot shows ARCH@2 + no decomposition, retry idempotent |

## Cross-instance Concurrency

§46: two DurablePlanStore instances prepare amendments from the same HEAD; A commits (ARCH@2); B's commit fails stale with `head_snapshot_mismatch` inside the transaction failure list — no branching architecture history. The durable single-writer/CAS assumptions are inherited unchanged (in-lock rehydration before every mutation).

## Corruption / Fail-closed Validation

See Durable Representation above — four new store_corrupt classes, each pinned by a test that hand-tampers the durable JSON and asserts the refused open.

## Tests Added

`test/r1-blocker-remediation.test.ts` — 25 tests: §8 raise rule (2), §4-§6 resolution lifecycle + bindings (4), §7/§42 self-block + unrelated-blocks (1), §10-§14 blocker-driven reopens (3), §16-§17/§48 abort (3), §18-§26/§37/§45 architecture remediation E2E (4), §41 deadlock-freedom property + synthesis-substate matrix (2), §46 cross-instance concurrency (1), §49 durable fail-closed (4), §38 reserved-kinds boundary (1). `test/durable-crash.test.ts` +4 windows +1 control pair. Updated pins: capabilities matrix literals (R1 grants), authority/validation boundary error-code expectations, and the four pre-R1 gate tests whose blocking conflicts are now seeded at the store level (the §8 raise boundary would refuse them — engine gate semantics unchanged and still pinned).

## Live OpenCode Validation

Extended `scripts/opencode-live-smoke.mjs` (§54): (a) registration check for `ultraplan_request_abort` + `ultraplan_prepare_architecture_amendment` on the real runtime; (b) live refusal — a real model invocation of `ultraplan_prepare_architecture_amendment` outside the remediation substate (run in architecture) is refused with structured `capability_not_available`. The full Proposal → Approval → PlanCommit remediation legs remain integration-tested with the controlled `ToolContext.ask` stub (headless cannot answer real dialogs — the standing honest boundary; no Allow was faked). Abort's interactive ask is exercised by the fake-context tool test (allow + deny).

## Verification Results

True producer exit codes, smokes run in ISOLATION from builds/tests (per brief §55):

```text
npm run typecheck -w @switchboard/opencode   exit 0
npm run lint       -w @switchboard/opencode  exit 0
npm test           -w @switchboard/opencode  exit 0   566/566 tests, 21 files
npm run build      -w @switchboard/opencode  exit 0
npm run smoke:opencode                       exit 0   37/37 checks (35 + 2 R1)
npm run smoke:opencode-handoff               exit 0   16/16 checks
npm run typecheck                            exit 0
npm run lint                                 exit 0
npm test                                     exit 0   claude-code 598 + 1 skipped;
                                                      codex 193; opencode 566
npm run build                                exit 0
```

First-run results reported honestly: the main smoke's FIRST run aborted 34/35 — the restarted server did not become ready in 60s (restart-readiness infra timing); the immediate re-run passed 37/37. The handoff smoke's FIRST run aborted 7/8 (`fetch failed` right after its restart ready-check); the immediate re-run passed 16/16. Environment note (disclosed for reproducibility): mid-verification the active nvm Node version was switched 22.23.2 → 24.21.0 by a concurrent workstream, which removed the globally installed `opencode` CLI binary mid-run; it was reinstalled at the pinned `opencode-ai@1.18.32` (the exact version all prior phases verified against) and both smokes were then run green. No retries were masked; every deterministic check passed on first run.

## Deviations / Architecture Amendment Candidates

No frozen-architecture text was modified. R1 realizes the frozen semantics directly: §7's Conflict resolution shape (status/resolution/action union) is implemented verbatim; §8's reopen flow extends to the Architecture (§7 already names `amend_architecture` as a resolution action and §9.1 admits ArchitectureRef amendments); §4's `aborted` lifecycle gains its writer. Amendment candidates for a future v0.1.1 editorial pass: (AM-10) §8's "an approved section or decision" wording extends to the Architecture via §7/§9.1 — make it explicit; (AM-11) document the §7 self-block exception next to §9.4's conflict-verification step; (AM-12) document the conservative DAG-invalidation rule (architecture revision ⇒ new decomposition mandatory) as the sanctioned alternative to §13's needs_review propagation when the decomposition base itself changes.

## R1 Exit Status

**COMPLETE.** All three targeted blockers are cured and machine-proven:

- **B-A:** Conflict lifecycle has a real open → resolved Proposal → Approval → PlanCommit path with deterministic remediation bindings.
- **B-B:** every blocking Question/Conflict the Harness can create in synthesis has a sanctioned route out (blocker-driven reopen) into a legal remediation path; abort exists as the explicit terminal escape.
- **B-C:** architecture-level findings/blockers have a real reopen → amendment → re-decomposition path.

Plus the brief's two structural guarantees: a blocking conflict cannot block its own sanctioned remediation (§7/§42), and an Architecture revision cannot leave the old Section DAG silently current (§26/§50). The deadlock-freedom property test demonstrates a sanctioned cure for every reachable active blocked state (§41).

## R2 Entry Conditions

R2 — Context Architecture Completion (B-D) is the next authorized remediation: Structural Retrieval → Projection → P0–P3 Budget Manager → Renderer, L0–L5 automatic context, evidence retrieval priorities, ContextTrace/equivalent, and the live compaction recovery proof. Only after R1 + R2 should the v0.1 Architecture Exit Review be re-run.
