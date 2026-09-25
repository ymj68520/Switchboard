# Phase 7 — Live Host Validation Record

Disposition: **PHASE 7 — FROZEN / PASS** (all live gates L1–L15 executed and passed on the real authenticated Claude Code host).

## Environment

| Item | Value |
| --- | --- |
| Date | 2026-09-25 |
| OS | Windows 10 (10.0.19044 x64), conhost terminal |
| Claude Code version | 2.1.282 (host auto-updated from 2.1.276 during validation; `DISABLE_AUTOUPDATER=1` pinned for all subsequent launches; all gates executed on 2.1.282) |
| Node (hooks/MCP runtime) | 24.21.0 (the runtime's fail-closed `UNSUPPORTED_NODE_VERSION` gate correctly refused Node 22.23.2 when 22 was first on PATH — observed once, fixed by environment) |
| Plugin implementation commit | 1071289 (host authority) + live-validation fixes in the freeze commit |
| Spec / amendment commits | fe5cf5b (spec with A1), 7d8e73e (A1), aca3524 (alignment), 04f3729 (A1 §6.4 reference fix) |
| Schema version | 5 (`PRAGMA user_version`), store ready |
| Authentication | authenticated (`claude auth status` → `loggedIn: true`, `authMethod: "oauth_token"`, first-party) |
| Data root | `C:\Users\Administrator\.claude\plugins\data\phase-plan-inline` — fresh at validation start. **Observed host fact:** for plugins loaded via `--plugin-dir` (inline plugins) the host sets `CLAUDE_PLUGIN_DATA` itself for plugin child processes (hooks + MCP), overriding the parent environment. Pre-state verified on this root: `planning_runs=0 session_bindings=0 proposals=0 approvals=0 plan_commits=0`, no `capability-proofs.json`. |
| Model note | the account maps the Opus tier to a relayed model (`glm-5.3-flash-cc[1M]`); the skill's `model: opus` frontmatter was resolved by the host's normal model mapping. Account configuration, not plugin behavior. |

## Gate results

- **L1 — hooks load: PASS.** `/hooks` reports "6 hooks configured": PreToolUse (1), UserPromptSubmit (1), UserPromptExpansion (1), SessionStart (1), SessionEnd (1), PermissionRequest (1). Plugin MCP server `plugin:phase-plan:phase-plan` connected (`hasTools: true`, 3 tools). Initially "0 hooks configured / No MCP servers" — root cause: `plugin.json` `"author": "Switchboard"` failed the host manifest schema (`claude plugin validate` → `author: Invalid input`), silently dropping the whole plugin. Fixed to `"author": {"name": "Switchboard"}`.
- **L2 — `/phase-plan` expansion: PASS.** Host debug log: `Hook UserPromptExpansion … provided additionalContext (413 chars)` (the signed entry token). The host expands the typed `/phase-plan` to the namespaced form; hook `command_name` observed was the bare `phase-plan`. The expansion matcher was widened to `^phase-plan(:phase-plan)?$` (both spellings accepted; handler likewise).
- **L3 — PreToolUse updatedInput: PASS.** Host log: `permissionDecision: "ask"` with `updatedInput` keys `[_entryIntent, goal, _hostContext]`; the decoded `_hostContext` carried sessionId, promptId, workspaceId, permissionMode (`default`, pre-transition), toolUseId, toolName, businessInputHash, signature.
- **L4 — ask reaches PermissionRequest: PASS.** Host log: PermissionRequest hook returned `{"behavior":"allow","updatedPermissions":[{"type":"setMode","mode":"plan","destination":"session"}]}`.
- **L5 — live session mode changed: PASS.** TUI status line changed from `manual mode on` to `plan mode on` immediately after the transition.
- **L6 — subsequent hook observes plan mode: PASS.** The next tool call's hook-injected context, decoded offline, reads `"permissionMode":"plan"` with `runId` + `bindingGeneration` present.
- **Store after entry:** one PlanningRun (`plan_a8389715…`, lifecycle=active, stage=discovery, revision=1, goal echoed), one attached SessionBinding (generation=1).
- **§8 settings check: PASS.** `~/.claude/settings.json` sha256 unchanged before/after; no `settings.local.json`; no project `.claude/` created; no `defaultMode` anywhere. Only `destination:"session"` exists in source.
- **Bonus — §41 ExitPlanMode guard: PASS (live).** During discovery the model attempted `ExitPlanMode`; PreToolUse denied: "Phase Plan has not completed Final Approval/Handoff. The PlanningRun is still active; ExitPlanMode cannot end it."
- **L7 — mandatory human prompt: PASS.** `approve_proposal` always produced the permission dialog with only **Yes / No** — no "don't ask again" option (unlike read-only get_state), demonstrating `anthropic/requiresUserInteraction` is enforced live ("This tool always requires explicit human approval and cannot be pre-authorized"). Input carried only `proposal_id/proposal_revision/proposal_hash` + injected `_hostContext`.
- **L8 — Allow commits exactly once: PASS.** Allow → handler executed; store verified: `approvals=1` (APPR-fb4b4a93…), `plan_commits=1` (CMT-cb44c835…), `plan_snapshots=1` (snap_2ea79dad…), `plan_heads` moved exactly once to (CMT-cb44c835 → snap_2ea79dad), proposal state `approved`.
- **L9 — Deny is not rejection: PASS.** Second awaiting proposal (PROP-fcedf57e…), Deny chosen in the dialog → handler did not execute; `approvals=1, plan_commits=1`, HEAD unchanged, proposal #2 remained `awaiting_approval` (no rejected/superseded/approved transition).
- **L10 — `/clear` ownership isolation: PASS.** `SessionEnd:clear` fired; S1 binding became `detached` (generation 2); run still active. In the new conversation S2 (same long-lived MCP process): `get_state` with a model-fabricated `_hostContext` → rejected (`HOST_CONTEXT_INVALID`); retry with empty token → rejected (`HOST_CONTEXT_REQUIRED`); `approve_proposal` → PreToolUse deny `STALE_SESSION_BINDING` ("no active Phase Plan run is attached to the current session"); `start_or_resume` → deny `ENTRY_INTENT_REQUIRED` ("only accepts a signed entry token produced by a /phase-plan skill invocation"). The model's own summary: model-supplied context is rejected by design; the MCP startup env session id is not mutation authority.
- **L11 — exact-session resume recovers the same run: PASS.** `claude --resume <S1-session-id>`; `Hook SessionStart:resume` provided additionalContext (215 chars): "Phase Plan active: run=… stage=architecture head=snap_2ea79dad… / Phase Plan run recovered. Claude Plan Mode must be restored by invoking /phase-plan." Binding reattached (`attached`, generation 3), same session id, same run, no new PlanningRun.
- **L12 — resumed non-plan state is fail-closed: PASS.** The live host did **not** restore Plan Mode on resume (status line `manual mode on` — the documented 2.1.x behavior). A plain prompt was blocked by the UserPromptSubmit hook with the A1 reason: "An active Phase Plan run was recovered, but Claude Code did not restore Plan Mode. Invoke /phase-plan to resume planning."
- **L13 — explicit `/phase-plan` restores Plan Mode: PASS.** Fresh UserPromptExpansion token → `start_or_resume` (same run, Case A) → `Allowed by PermissionRequest hook` with `setMode(plan, destination=session)`; status line returned to `plan mode on`; post-recovery injected context decodes to `"permissionMode":"plan"` with a fresh `promptId` and `bindingGeneration: 3`.
- **L14 — mode recovery mutates nothing: PASS.** After recovery: `planning_runs=1`, same `run_id`, `revision=2` (unchanged — the 2 came from the earlier approval), `approvals=1`, `plan_commits=1`, HEAD unchanged.
- **L15 — capability proof only after real success: PASS.** `record-capability-proof --hooks-verified --plan-mode-verified --claude-version=2.1.282` (runtime command; JSON never hand-edited) then `doctor`: "Claude capabilities PASS …; **runtime-verified: planModeIntegration, hookLifecycle**"; Plan Store PASS schema=5. Version invalidation (stale `claudeVersion` → proof ignored → UNKNOWN) is pinned by unit tests.

## Host facts observed (documentation input, no code change required)

1. Inline plugins (`--plugin-dir`) get a host-managed `CLAUDE_PLUGIN_DATA`; a parent-provided value does not reach plugin children.
2. `/hooks` displays all hook events including those with no configured hooks; counts appear only on configured events.
3. Interactive terminal resume does not restore Plan Mode (confirms Amendment A1's premise on 2.1.282).
4. `requiresUserInteraction` removes the "don't ask again" option from the permission dialog entirely.
5. PreToolUse `ask` for `start_or_resume` is resolved by the PermissionRequest hook's allow+setMode decision (no extra dialog); `approve_proposal` always reaches the human dialog.

## Prohibitions honored

No settings/account changes, no nested Claude, no simulated plan-mode restoration, no debug MCP mutation tools (fixtures used the domain's own prepare path under `test/live-fixture.test.ts`, guarded by `PHASE_PLAN_LIVE_STORE`), no Phase 8 surface. No secrets, tokens, or private transcript content recorded here.
