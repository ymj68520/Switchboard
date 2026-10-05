# OpenCode v0.2.0 Legacy-Path Audit (Release Closure Record)

**NON-NORMATIVE RELEASE AUDIT ARTIFACT** (Phase 8 §28–§30, §65). The architecture authority remains the v0.2.0 supervised-execution Architecture Specification. Scope: `adapters/opencode/`.

## Release decision (§65, frozen)

```text
legacy free-Build:  retained ONLY for persisted legacy_v0_1 handoff recovery
new production creation of a legacy handoff:  IMPOSSIBLE (store-level refusal)
```

Pre-cutover legacy recovery is preserved verbatim (Phase 8 does not delete it). The migration matrix (`test/migration-matrix.test.ts`) proves every legacy store class still loads and completes recovery through the REAL legacy machinery.

## Inventory and classification (§28)

| Item | Location | Classification |
|---|---|---|
| `ExecutionHandoff` / `HandoffDelivery` types + hash/projection | `src/handoff/types.ts`, `src/handoff/assemble.ts` | legacy recovery required (pre-cutover durable handoff state) |
| Store handoff families + workflow | `executionHandoffs`, `handoffDeliveries` families; `saveExecutionHandoff`, `prepareHandoffDelivery`, `beginHandoffDispatch`, `reclaimHandoffDispatch`, `recordHandoffDelivered`, `completeHandoffRun` (`src/memory/store.ts`) | legacy recovery required |
| `recoverExecutionHandoff` (crash-window recovery A–F) | `src/core/controller.ts` | legacy recovery required |
| Idle-triggered recovery route (`session.idle` → `maybeRecoverHandoff`) | `src/index.ts` event hook | legacy recovery required (routes BY the durable protocol discriminator: marker-absent runs → legacy recovery; marker runs → supervised state machine) |
| Legacy free-Build host bridge (`OpenCodeExecutionAdapter.dispatchHandoff` / `findHandoffDelivery`) | `src/runtime/opencode-execution-adapter.ts` | legacy recovery required (the only dispatcher of marker-absent handoffs) |
| Runtime handoff bundle wiring (`executionRuntime` in `getProjectInstance`) | `src/runtime/instance.ts` | legacy recovery required (feeds ONLY the legacy recovery route) |
| Legacy status rendering (delivery resolution in `renderRunStatus`) | `src/memory/renderer.ts`, `src/core/controller.ts` | legacy recovery required (marker-absent runs render legacy delivery state) |
| Dead new-path → legacy bridges (compat shims, fallback branches) | none found | nothing to remove (§29 audit: every legacy entry point is reachable ONLY from marker-absent durable state; no new-path code calls into legacy helpers) |

## Reachability proof (§30/E37/E38) — two independent layers

**Layer 1 — controller routing.** `maybeRecoverHandoff` resolves the handoff protocol from the durable run header via `planningRunHandoffProtocol(run)` (`src/core/execution-handoff-protocol.ts`: absent marker ⇒ `legacy_v0_1`, never artifact-inferred). A run durably marked `supervised_v0_2` is routed into the supervised handoff state machine (`recoverSupervisedHandoff`) and can never reach `recoverExecutionHandoff` or the legacy dispatch.

**Layer 2 — store/service refusal (source-level).** For any run whose resolved protocol is `supervised_v0_2`, the legacy handoff services refuse authoritatively: `saveExecutionHandoff`, `prepareHandoffDelivery` (and the dispatch/reclaim/completion family) throw `handoff_not_allowed` (`src/memory/store.ts` §2560–§2599). `recoverExecutionHandoff` carries the same deep guard. Additionally the durable loader FAILS CLOSED on impossible histories: a marker-absent (legacy) run carrying ExecutionRuns for the plan is corruption (`src/memory/document.ts`), and a supervised run carrying legacy handoff artifacts is corruption.

**Enforcing tests:** `test/execution-production-handoff.test.ts` (legacy isolation: store refusal under a supervised run; `recoverExecutionHandoff` blocked; a PRE-CUTOVER document still completes legacy recovery with zero execution runs), `test/migration-matrix.test.ts` (legacy pending/completed stores load and recover through the real machinery), `test/handoff.test.ts`, `test/final-plan.test.ts` (pre-cutover compatibility expectations per Phase 7B §103), `scripts/crash-probe.mjs` (process-level window E–F recovery on marker-absent documents).

**Live proof:** the E73 live run records `legacyDispatchCount = 0` — the `OpenCodeExecutionAdapter` dispatch surface was instrumented for the whole run and never invoked.
