# Phase 14 Implementation Note — ExecutionHandoff, Plan → Build Transition & Build Read-Side

Status: COMPLETE. Schema 10 → 11, 15-tool MCP surface, live host validated.
Baseline honored: Phase 13 (`af01ed8` + `9ddacc1`), Phase 12 (`eba77f4` + `888e8f2`). Phase 13 was not amended.

## 1. Host transition probe H1–H8 (§4–§5)

Executed BEFORE any implementation with a standalone probe plugin
(`C:\Users\Administrator\phase14-probe\probe-plugin`, one MCP tool + dump
hooks; raw logs under `logs/`), Claude Code **2.1.283**, Windows 10.0.19044:

| Probe | Question | Result |
|-------|----------|--------|
| H1 | `PermissionRequest.updatedPermissions: setMode(default, destination=session)` really switches out of Plan Mode | PASS — PostToolUse input `permission_mode: "default"` |
| H2 | Next hook input mode | PASS — following UserPromptSubmit reports `default`, same session |
| H3 | TUI leaves plan mode | PASS — "plan mode on" → "manual mode on" (2.1.283 renders default as *manual mode on*) |
| H4 | MCP handler continues after setMode | PASS — tools/call executed; transcript shows "Allowed by PermissionRequest hook"; **no human dialog** |
| H5 | PostToolUse `permission_mode` after MCP success | PASS — `default` |
| H6 | PostToolUse accuracy | PASS — exact `tool_use_id` (same as PreToolUse), full `tool_response`, correct `session_id` |
| H7 | model-tier observables | Model string `glm-5.3-flash-cc[1M]` unchanged across the transition (relay-mapped; no independently observable tier). Per §5: recorded as *mode switched, no custom model override, native opusplan policy responsible* — not a blocker |
| H8 | No settings writes | PASS — user `settings.json` sha256 identical; no workspace settings files created |

Probe-side discoveries that shaped the implementation:

1. **hooks.json matchers are fully-anchored regexes against the FULL MCP tool
   name** `mcp__plugin_<plugin>_<server>__<tool>`. The frozen phase-plan
   convention `mcp__.*phase.plan__(…)$` is exactly that.
2. **Hook response JSON must be printed by the hook program itself** — an
   inline JSON literal in the `command` string is mangled by cmd.exe quoting
   (host log: "Unrecognized token '\' → treating as plain text", hook
   ignored). The production runtime already prints its responses.
3. **PostToolUse matchers match MCP tool names ONLY as exact literals** on
   2.1.283 (probe-proven: literal fired, regex `mcp__.*…` did not; built-in
   `Read|Grep|…` alternations keep working). `hooks/hooks.json` therefore
   carries the handoff PostToolUse registration as an exact literal entry.
   PreToolUse/PermissionRequest regex matchers behave as documented.

## 2. Schema v11 (§11–§21)

`011-execution-handoff-foundation` (backup + `BEGIN IMMEDIATE` + registry +
rollback + fencing all reused unchanged):

- `execution_handoffs` — immutable (no_update/no_delete); `UNIQUE(run_id)`,
  `UNIQUE(final_plan_id)` ⇒ at most one canonical handoff per run and per
  FinalPlan (§12); FK-bound to the same-run approved `final_plans` row.
- `execution_handoff_events` — append-only; vocabulary CHECK
  `PREPARED | DELIVERY_ATTEMPT | DELIVERED` (no SET_STATUS/FORCE_DELIVERED
  can even be expressed, §16).
- `execution_handoff_states` — the ONLY mutable table: materialized
  operational delivery state (`status`, `last_event_seq`,
  `current_attempt_tool_use_id`, `delivered_at`); mutated exclusively as
  append-event + update in one transaction (§14/§17).
- `execution_bindings` — PK(final_plan_id), `UNIQUE(run_id)`, partial unique
  index `(session_id) WHERE state='attached'` ⇒ one binding per FinalPlan,
  one ATTACHED binding per session (§19); generation is the Build fencing
  epoch (§20): initial attach = 1, detach +1, exact-session reattach +1
  (`XB-01…03` in `src/store/execution.ts`).

`validateSchemaV11` (§97/§136) checks bounded data facts only — never a
history replay: handoff↔FinalPlan same-run + hash equality, per-handoff hash
recomputed from the canonical payload, state↔event coherence, DELIVERED
has PREPARED lineage, binding workspace = run workspace, completed-run-with-
handoff ⇒ delivered, delivered ⇒ approved FinalPlan exists, triggers present.
`SUPPORTED_SCHEMA_VERSION = 11`; old writers fence with
`STORE_SCHEMA_TOO_NEW` (E75).

Migration seams (§98–§100): an approved schema-10 FinalPlan run migrates to
active/final with `handoffPending` derived true and **nothing fabricated**
(§99); legacy completed runs are never given handoffs or bindings (§74/§98);
failing-011 rolls back to a fully valid schema-10 store (§101/§76). Covered
by `test/store-migration-v10.test.ts`.

## 3. ExecutionHandoffV1 (§22–§31)

`src/core/execution-handoff.ts` (PURE). Every field server-derived (§22):
`finalPlan{id,revision,hash}`, `repositoryBaseline`, `goal` (run row),
`hardConstraints` (exact FinalPlan constraint refs filtered to
`severity === "hard"` by loading the exact memory revisions, §26),
`architectureRef`, `implementationSteps` (manifest order copied verbatim),
`requiredContracts` (ALL current FinalPlan sections — the full execution
contract, not just the active section, §27), `criticalDecisions`
(§28 conservative mapping: **no formal decision criticality classifier
exists, so every exact FinalPlan decision ref is included**), 
`knownLimitations` (approved synthesis limitations verbatim, §29),
`validationRequirements` (§30: **empty because no canonical source exists in
the approved planning schema** — recorded here rather than inventing one).
No Evidence/Section/gate reruns (§47/§48); the model authors nothing.

Hash (§31/E11): sha256 over the canonical content payload only; handoff id,
timestamps, delivery state, session id and binding generation are not part of
the payload — Build edits never change the baseline or the hash (§25).

Repository baseline (§24/§25): git workspace ⇒ `git rev-parse HEAD` via the
frozen probe (`observeGitHeadSync`: fixed argv, `shell:false`, bounded
timeout, regex-validated); directory workspace ⇒ `{kind:"directory",
revision:null}` — no pseudo-revision is ever invented. Probe failure fails
closed (`HANDOFF_NOT_AUTHORIZED`).

## 4. Handoff state/event model & delivery (§14–§17, §35–§43)

`src/application/handoff-service.ts`:

- `prepareHandoffDelivery` (§35, one write transaction): eligibility
  recheck (active + final + workspace + approved FinalPlan) → derive or
  reuse the canonical handoff (reuse verifies the stored hash; §42 — a
  prepared handoff is never re-derived; the same (session, toolUseId)
  identity does not duplicate attempts) → create/reuse the ExecutionBinding
  (§90: new ⇒ gen 1; attached-same-session ⇒ reuse; detached-same-session ⇒
  reattach +1; any other session ⇒ `EXECUTION_BINDING_REQUIRED`, no
  takeover §82) → `DELIVERY_ATTEMPT` bound to the exact tool_use_id.
  The PlanningRun stays active and revision +0 (§36/§50).
- `finalizeDelivery` (§37/§93, one write transaction): exact attempt lookup
  by (run, session, tool_use_id) + stored handoff id/hash verification —
  the response alone is never trusted — then `DELIVERED` event + state →
  delivered (`delivered_at`) + PlanningRun `active → completed`
  (stage stays final) + **revision +1 exactly once** (guarded UPDATE +
  post-read verification) + planning SessionBinding detach (+1, tolerating
  already-detached recovery states). ExecutionBinding untouched (§31/E31).
  Idempotent: replays of the delivered state return `alreadyDelivered`
  and change nothing (§39/§116/E70).

`handoffPending` (§43) is a derived condition
(`isHandoffPendingInTx`): active + final + approved FinalPlan + no delivered
handoff — including "no row yet" and "prepared". The run is never completed
inside the MCP handler (§36): PostToolUse is the acknowledgement boundary.

## 5. Host transition (§6–§10, §87–§89)

The Phase 7 mechanism is reused inverted. Normal path (§88): PreToolUse
validates eligibility BEFORE any mode change (§7) and returns `ask` with a
signed V2 context; the PermissionRequest hook re-verifies the signed
context, session, prompt AND the full Store-side eligibility (active run at
final, same-workspace, approved FinalPlan, not delivered) and only then
returns `allowWithPermissions([{type:"setMode", mode:"default",
destination:"session"}])` — the same session-scoped primitive the probe
proved (H1). It never touches user/project/local settings or defaultMode
(§8/E19). ExitPlanMode is not used (§9) and stays denied while pending with
the §10 reason; after completion the guard naturally falls away. Recovery
(§86/§89): when `permission_mode != plan` the PreToolUse hook signs the
context with NO permission decision — handoff retries directly in
default/manual mode, never default → plan → default. §87 makes handoff the
only mutation-like capability legal outside plan mode, and only while
pending. The validator/subagent caller is denied at the MCP layer
(`VALIDATOR_MUTATION_FORBIDDEN`, §33/E16 — handoff joined the V2-attested
family so the agent fields are signed).

## 6. PostToolUse delivery finalizer (§37–§39, §93)

`hooks/hooks.json` registers PostToolUse for the handoff MCP tool (exact
literal matcher — see probe discovery 3). The finalizer parses the MCP
response envelope, resolves the run (attached active run, else the delivery
identity), and calls `finalizeDelivery`; success injects the §38 context
("Phase Plan execution handoff delivered. … Plan Memory is read-only."),
failures are fail-VISIBLE with a retry instruction. No model-facing
completion primitive exists (`complete_run`/`mark_handoff_delivered`/
`set_execution_binding` are internal-only, §94); only the application
service, store primitives and the trusted finalizer can change
delivery/completion state (§95). Handoff audit lives exclusively in
`execution_handoff_events` — no `HANDOFF_DELIVERED` audit_event was added
(§96).

## 7. Crash recovery (§40–§42, §114–§115)

- Window A (mode switched, handler died before PREPARED): nothing stored;
  retry derives the handoff in whatever mode the session is in (§86) and
  completes normally.
- Window B (PREPARED + binding, finalizer lost): Build reads fail closed
  (`EXECUTION_CONTEXT_NOT_AVAILABLE` — §90 requires delivered + completed);
  the retry reuses the exact handoff (verified hash), appends a fresh
  DELIVERY_ATTEMPT, and the next successful finalizer completes.
- Multi-process race (§117): UNIQUE(run_id) converges both workers on one
  canonical handoff; attempts append; the first DELIVERED wins and the
  loser replays idempotently.
- SessionEnd vs delivery (§118): either ordering leaves completed run +
  delivered handoff + binding attached-or-detached per session lifecycle —
  never contradictory.

## 8. ExecutionHostContextV1 & Build read-side (§53–§67, §91–§93)

`src/host/execution-context.ts`: separate signature domain
`phase-plan:execution-context:v1` (§54) — a Planning HostContext fails
execution verification before the HMAC even matters and vice versa
(E44/E45, both directions tested). The reserved `_hostContext` field is
shared, but the signed `authority:"execution"` field decides the parser
(§55). Every Build read re-verifies: HMAC → tool binding → business-input
hash → Store revalidation of completed run + delivered handoff + attached
exact-session binding with exact generation (§56; mismatch ⇒
`STALE_EXECUTION_BINDING`, everything else ⇒
`EXECUTION_CONTEXT_NOT_AVAILABLE`, §91).

Surface (§57): no new read tools — `get_state` (§58 compact view: run
completed/final, FinalPlan identity, handoff id/hash/delivered, binding
generation/state, repository baseline; no session ids), `get_context`
(§59: new `detail:"build"` returning the canonical handoff + deterministic
rendered **Execution Contract**; other details are `CAPABILITY_NOT_AVAILABLE`),
`read_memory` (§62–§66: exact refs only, membership in the approved
FinalPlan closure enforced — historical revisions fail
`EXECUTION_MEMORY_REF_NOT_AUTHORIZED` even though they exist in the same
run (§64); open_questions/conflicts are `CAPABILITY_NOT_AVAILABLE` (§65);
`detail=contract` works for FinalPlan sections (§66); `final_plan` itself
is NOT a memory kind — it is read via `get_context(detail=build)` (§67).
`ExecutionContextV1` is deliberately NOT a PhasePlanContext v5 (§60) and
needs no context epoch — the immutable handoff hash is the anchor (§61).
The PreToolUse hook signs execution contexts for these reads when (and only
when) the Store shows delivered + attached exact-session binding, granting
the allow outright — the signed revalidation IS the permission decision.

## 9. Completion semantics & frozen boundaries (§49–§52, §68–§72, §83–§84)

Completion happens exactly once, in the delivery transaction: lifecycle
`active → completed` (terminal; no legal transition back), stage stays
`final`, revision +1 exactly once, planning SessionBinding detach (+1) —
all old planning tokens then fail `STALE_SESSION_BINDING` (§52). HEAD
never moves and no PlanCommit is ever created (§51/E32/E33). After
completion every planning mutation fails closed (`RUN_TERMINAL`/
`STALE_SESSION_BINDING`/`CAPABILITY_NOT_AVAILABLE` per layer, §133);
post-completion handoff invocations with a new identity fail
`HANDOFF_ALREADY_DELIVERED`/`STALE_SESSION_BINDING` while the exact
original invocation identity replays idempotently under a signed execution
context (§134). Observation capture (§69) stops through the existing
`findAttachedActiveRun` gate — a completed run is not attributable; Build
edits therefore never mark Evidence stale, never rewrite the Finalization
audit snapshot, and never flip Sections (§70/§71) — the frozen commit-time
audit remains the planning closure. `start_or_resume` on a Build-bound
session returns `EXECUTION_REPLAN_NOT_AVAILABLE` (§83) while other sessions
in the same workspace keep full planning freedom (§84). `/clear` and fork
cannot inherit the binding (new session id ⇒ no rows; §80/§81); only
exact-session resume reattaches (§79/§82).

## 10. Build compact/resume recovery (§77–§79, §85–§86, §111–§112)

SessionStart gains two injections ahead of the planning capsule: a
delivered handoff with an attached exact-session binding injects the
rendered `[Phase Plan Execution Contract v1]` block for startup/resume
AND compact sources (§77/§78 — the compact summary is non-authoritative
exactly like Phase 8); `resume` first reattaches the session's detached
execution bindings (+1) on the matching workspace (§79). A handoff-pending
session gets the §85 notice (approved FinalPlan, pending handoff, prepared
handoff id/hash when present, "Plan Mode restoration is not required" —
never the A1 wording, §86). SessionEnd detaches execution bindings like
planning ones (advisory; generation fencing carries correctness).

## 11. Live validation summary (2.1.283)

Production store (`phase-plan-inline`) migrated 10→11 on first open; run A
(`plan_0b19abed…`, approved FinalPlan `fplan_cdf2e6ad…`) resumed by exact
session id — the full §121 chain was exercised live: plan mode on →
`phase_plan.handoff` → PreToolUse eligibility → PermissionRequest
`setMode(default, session)` with **no human dialog** → handler derived
`xhandoff_b33e9820…` (hash `sha256:2ce7b2a2…`) → response payload verbatim
on screen (goal, architecture ARCH-1@1, contracts SEC-1@1/SEC-2@1,
implementation order, baseline "directory workspace") → TUI left plan mode
("manual mode on", harness-confirmed) → DELIVERED + run completed +
revision 9→10 + planning binding detached, all store-verified. The PostToolUse
delivery was additionally exercised through the exact hook binary with the
faithful live payload (§38 context emitted) after the probe revealed the
host's PostToolUse literal-matcher requirement; a live idempotent replay
then confirmed `alreadyDelivered` behavior and a new-identity post-completion
call failed closed (`STALE_SESSION_BINDING`). Build read-side: 5/5 live —
`get_state` compact view, deterministic `get_context(detail=build)`,
`read_memory` ARCH-1@1 and SEC-1@1 contract under `authority:"execution"`,
and SEC-1@2 refused `EXECUTION_MEMORY_REF_NOT_AUTHORIZED`. Execution smoke:
`BUILD_SMOKE.txt` written with no Phase Plan denial and normal Claude
permission behavior, then removed. `/compact` restored the Execution
Contract (model quoted header/ids/hashes verbatim); `/exit` detached the
binding (gen +1) and `--resume` reattached (+1) with the same contract.
Settings files untouched throughout (H8). Session id identical before and
after the transition (§123).

## 12. Phase 15 boundary

Not implemented, by directive: ExecutionIssue, replanning from a completed
FinalPlan, subsequent-run baseline, execution progress orchestration
(`start_or_resume` stays `EXECUTION_REPLAN_NOT_AVAILABLE` for Build-bound
sessions), execution takeover, any progress/step/task persistence.
