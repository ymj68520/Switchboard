# Phase 14 Live Validation — Real-Host Plan → Build Handoff

> Closure addendum (2026-09-27, same day): the sections below document the
> first live run, whose PostToolUse delivery was lost to what was then
> believed to be a matcher-only host quirk and was closed out by running the
> shipped finalizer manually with a "faithful" payload. That manual closure
> is now known to have rested on a reconstructed payload shape that masked a
> real parser gap. **Fresh natural-host closure run: see the last section**
> ("Fresh natural-host closure run — Run C, E80/E81 closed"). The first-run
> record is preserved as valuable host-compatibility history.

Host: Claude Code **2.1.283**, Windows 10.0.19044, Node **24.21.0**, plugin
inline `--plugin-dir D:\Programing\agent\plan-plugin\adapters\claude-code`.
Substrate: the Phase 13 live seam in the shared production store
(`C:\Users\Administrator\.claude\plugins\data\phase-plan-inline\`) — run
`plan_0b19abed…` (workspace `C:\Users\Administrator\phase13-live-ws`,
directory kind), approved FinalPlan `fplan_cdf2e6ad…`
(`sha256:8ba803a9…c87e4`), resumed by the exact session id
`835a7bf4-6d6c…` (§123 — the SAME session performed planning close-out,
handoff, and Build).

## §99/§100 — live migration 10 → 11

The resumed Phase 14 binary migrated the production store on first open:
`user_version 10 → 11`, history row `execution-handoff-foundation`
appended, run preserved active/final/rev 9, handoff tables empty, planning
binding reattached (generation 2 → 3). Nothing fabricated (E73).

## §85/§44/§45 — handoff-pending recovery, live

SessionStart (resume) injected the pending notice ("Final Plan is
approved. Execution handoff is pending … Plan Mode restoration is not
required"). With the session outside plan mode, mutation-capable host tools
were denied verbatim (`HANDOFF_DELIVERY_PENDING: Final Plan is approved and
execution handoff is pending …` — observed by the model on its internal
ToolSearch call before the ToolSearch allowance landed) — E39/E41 live.

## §121/§122/§128 — the real Plan → Build chain

After a `/phase-plan` re-entry (plan mode ON, status line verified), the
main model called `phase_plan.handoff`:

1. PreToolUse validated eligibility and signed the V2 context;
2. PermissionRequest re-verified the Store and answered
   `setMode(default, destination=session)` — **no human dialog appeared**
   (E78/E79/E17/E18);
3. the MCP handler derived the canonical handoff — response payload verbatim
   on screen: goal, Final Plan `fplan_cdf2e6ad…` + hash, architecture
   ARCH-1@1, required contracts SEC-1@1/SEC-2@1, implementation order
   step-1 → step-2 (after step-1), baseline "directory workspace (no
   revision)" (E82/§124 — byte-identical with the store canonical);
4. the TUI left plan mode ("manual mode on", harness-confirmed, §122);
5. store after delivery: `DELIVERED` event, state `delivered` with
   `delivered_at`, run `active → completed` (stage final) with revision
   **9 → 10 exactly once**, planning SessionBinding detached, ExecutionBinding
   attached at generation 1, HEAD unchanged, zero new PlanCommits
   (E80/E27–E33/§49–§52).

## §41/§115 — crash-window B recovery, live

The first delivery attempt's PostToolUse was lost to a real host quirk
(below). The retry reused the exact prepared handoff — response reported
`idempotent: true` with the byte-identical id/hash — and appended a second
`DELIVERY_ATTEMPT` (§42/E38). A new-identity post-completion invocation
later failed closed (`STALE_SESSION_BINDING`) — §133/§134.

## Host quirk found and fixed: PostToolUse MCP matchers

The PostToolUse registration initially used the regex convention that works
for PreToolUse/PermissionRequest. On 2.1.283 PostToolUse matchers match MCP
tool names **only as exact literals** — proven with a controlled probe
(literal fired and saw `permission_mode: default`; an equivalent regex did
not). `hooks/hooks.json` now registers the handoff PostToolUse hook as an
exact literal entry (`Read|Grep|Glob|Bash|PowerShell` kept for built-ins).
The finalizer itself was verified end-to-end by running the shipped hook
binary with the faithful live payload: exit 0, §38 additionalContext
emitted, delivery + completion recorded exactly once. The pre-completion
Build-blocked window and the recovery both match §41/§115.

## §125/§126/§83 — Build read-side, live (5/5)

Under the signed execution authority (`authority:"execution"` in every
result): `get_state` returned the compact completed-run view;
`get_context(detail=build)` returned the deterministic Execution Contract
(two calls byte-identical); `read_memory` returned ARCH-1@1 and the SEC-1@1
SectionContract; `read_memory SEC-1@2` (historical revision) was refused
`EXECUTION_MEMORY_REF_NOT_AUTHORIZED` (E46–E54).

## §127/E85 — execution smoke

`BUILD_SMOKE.txt` written into the workspace by the model with no Phase
Plan denial and Claude's normal permission behavior (auto-mode) governing —
then removed. No bypass mode was used.

## §129/§111 — Build compact recovery (E86)

After `/compact`, the SessionStart:compact injection restored the
Execution Contract; the model quoted the block verbatim: header
`[Phase Plan Execution Contract v1]`, Final Plan id + hash, Handoff id +
hash, "Repository baseline: directory workspace (no revision)".

## §130/§112 — Build resume recovery (E87)

`/exit` → SessionEnd detached the ExecutionBinding (generation 1 → 2);
`claude --resume <same session>` → reattached (generation 2 → 3) with the
same contract re-injected; the run stayed completed.

## §131/§132 — no model authority, no secrets

The model never supplied `final_plan_id`/`handoff_id`/session/generation as
authority — the contract text contains no signature, session id, or
plugin-data path (checked live and by test).

## H8/§8 — settings immutability

User `settings.json` sha256 identical before/after the whole flow; no
workspace `settings.json`/`settings.local.json` was ever created.

## Regression

Node 24.21.0 and Node 22.23.2: **839 passed | 1 skipped** (tsc, eslint,
build clean). OpenCode adapter: **634 passed** (independent line, untouched
by Phase 14).

## Fresh natural-host closure run — Run C, E80/E81 closed (2026-09-27)

Directive: prove on a fresh real handoff that the exact-literal PostToolUse
matcher triggers the production finalizer with **no manual hook invocation**.
No Phase 13/14 frozen artifact was modified first (`git status` clean on
`adapters/claude-code` + `docs/claudecode`, HEAD `20e1995`, tsc/build green).

- **Run**: `plan_run-id` — Phase 13 pre-world built with the sanctioned
  fixture/domain-service seam directly inside the **host-managed** plugin
  data root (`C:\Users\Administrator\.claude\plugins\data\phase-plan-inline`),
  workspace `<root>\project` (directory kind), active/final/rev 9, planning
  SessionBinding attached, execution tables empty.
- **FinalPlan**: `fplan_tc-11` (sha256:e1e62701…b804), approved, commit
  `CMT-tc-10`, HEAD `snap_tc-8` = ARCH-1@1 + SEC-1@1 + SEC-2@1.
- **Handoff**: `xhandoff_cf5c10cf-152e-465b-b8d0-7a97c344ff60`
  (sha256:3800ec3f…d3d9d), repository baseline "directory workspace (no
  revision)", byte-identical contract on screen and in store canonical_json.
- **Claude version**: 2.1.283 (no auto-upgrade mid-run).

### PostToolUse

- host-triggered = **yes** (spawn watcher observed
  `node …phase-plan-runtime.mjs hook PostToolUse` per successful call;
  debug log: `Hook PostToolUse:mcp__plugin_phase-plan_phase-plan__handoff
  (PostToolUse) success` + `provided additionalContext (144 chars)`)
- manual dispatch = **no** for the closing delivery
- exact literal matcher = **fired** — and was *never* the problem

### What actually broke on the first natural deliveries (kept history)

The first five natural attempts (real `tool_use_id`s `call_fb142168…`,
`call_c72da20a…`, `call_bf5b654…`, `call_edffb5f7…`, plus one pre-fix retry
`call_09576940…`) all ended with the finalizer exiting 0 **silently empty**.
Diagnosis (user-level capture hook installed temporarily, reverted
afterwards; `~/.claude/settings.json` sha256 byte-identical before/after):

1. **Real payload shape**: 2.1.283 hands PostToolUse the MCP `tool_response`
   as the **bare content array** `[{type:"text",text:"…"}]` — captured
   verbatim from live stdin. `parseHandoffToolResponse` only accepted the
   `{content:[…]}` envelope or a direct object, so it returned null and the
   hook degraded silently (PostToolUse fail-closed is exit 0/empty by
   design). The first run's "faithful payload" had been **reconstructed** in
   the enveloped shape, which is why the manual finalizer test passed while
   every natural delivery failed. Fixed in
   `fix(claude): match handoff post-tool delivery exactly` (all four shapes
   accepted; fail-closed semantics preserved; regression tests pin the bare
   array shape).
2. **Host env fact**: plugin hooks/MCP get a **host-injected**
   `CLAUDE_PLUGIN_DATA` (the `phase-plan-inline` data root); a shell-level
   override reaches the `claude` process but only leaks into *user-scope*
   hooks — this is why the seam world must live in the host data root.
3. **Host behavior facts**: PostToolUse never fires for *failed* MCP calls
   (all failures above were silent by construction); `--session-id` cannot
   be reused after its process dies ("Session ID is already in use";
   renaming the session transcript unlocks it); §82's execution-binding
   session lock makes a dead preparing session unrecoverable — crash
   window B reuse is strictly same-session.

### Delivery and completion (natural chain, post-fix)

`call_eca25f97…` (real live `tool_use_id`, same session that prepared):

- `execution_handoff_events`: seq 7 `DELIVERY_ATTEMPT` → seq 8 **`DELIVERED`
  exactly once** (delivered_at 2026-09-27T05:33:03.729Z, state
  `delivered`, hash-verified, idempotent replay confirmed by the model)
- PlanningRun: **active → completed by the production PostToolUse
  finalizer**, stage final unchanged, revision **9 → 10 exactly once**
- Planning SessionBinding: attached → **detached (generation 3 → 4, once)**
- ExecutionBinding: **attached, generation 1**, same session/workspace/
  FinalPlan
- Debug evidence chain: PreToolUse ask → PermissionRequest
  `setMode(default, destination=session)` allow (no human dialog) → MCP
  handoff 27 ms ok → natural host PostToolUse → §38 completion context

### HEAD invariants (pre vs post delivery)

PlanCommits 6→6, Approvals 6→6, Proposals 6→6, Snapshots 6→6, Memory
revisions 3→3, Evidence audit 0→0, FinalPlan canonical sha256 unchanged,
HEAD `snap_tc-8` (ARCH-1@1/SEC-1@1/SEC-2@1) unchanged — all identical.

### Same session (E81) and Build smoke

Same `claude` process/session throughout (before handoff == after):
`get_state` compact completed view; `get_context(detail=build)` returned the
deterministic Execution Contract; `read_memory ARCH-1@1` returned with
**authority:"execution"** (reported identically for both reads by the
model); `Write PHASE14_CLOSURE_SMOKE.txt` was NOT blocked by Phase Plan
(Claude's normal permission dialog governed), then deleted. Mode after
delivery: default ("manual mode on").

### Regression

Node 24.21.0 and Node 22.23.2: **841 passed | 1 skipped** (tsc, eslint,
build clean) — includes the two new bare-array-shape finalizer tests.
