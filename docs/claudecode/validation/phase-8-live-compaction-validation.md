# Phase 8 Live-Host Validation — Real Compaction Recovery (§58/§61)

Status: **PASS** — every gate below was executed against a real, authenticated,
interactive Claude Code host; no settings workarounds, no debug mutation tools,
no hand-written capability proofs.

Host: Claude Code **2.1.282** (same binary throughout; auto-updater disabled),
Windows 10.0.19044, Node **24.21.0** first on PATH (launcher batch file),
auth `oauth_token` (`loggedIn: true`, verified via `claude auth status`).
Plugin: inline `--plugin-dir D:\Programing\agent\plan-plugin\adapters\claude-code`
(bundle built fresh from the committed Phase 8 tree, commit `4b19018`).
Workspace: `C:\Users\Administrator\phase8-live-ws` (fresh workspace registration).
Store: the host-managed inline-plugin root
`C:\Users\Administrator\.claude\plugins\data\phase-plan-inline\store\phase-plan.sqlite3`
(the host overrides `CLAUDE_PLUGIN_DATA` for plugin children — Phase 7 host fact).
Debug evidence: `C:\Users\Administrator\phase8-live-ws\debug.log` (`--debug --debug-file`).
Session: id `d0b54820-228d-4998-b758-693713a9cd71` (resumable).

## 1. Plugin load (L1-equivalent)

- Debug log: `plugin: phase-plan (enabled=true): …\hooks\hooks.json`; all six hook
  events registered; `MCP server "plugin:phase-plan:phase-plan": Successfully
  connected (transport: stdio)`.
- The MCP server's own stderr banner reports the Phase 8 surface:
  `mcp server 'phase-plan' v0.1.0 ready on stdio (5 tools)` — exactly
  start_or_resume, get_state, get_context, read_memory, approve_proposal.
- No settings.json/settings.local.json modification; no defaultMode; Plan Mode
  reached only via the `/phase-plan` → PermissionRequest `setMode(plan,
  destination=session)` chain (log: `Applying permission update: Setting mode to 'plan'`).

## 2. `/phase-plan` smoke + run creation

`/phase-plan Phase 8 live compaction validation` → expansion resolved to the
namespaced `phase-plan:phase-plan` form → signed EntryIntent → PreToolUse ask +
injected `_hostContext` → PermissionRequest hook allow with
`setMode(plan, destination=session)` → `start_or_resume` completed (31 ms) →
run `plan_12e31dc9-edeb-44bf-9e61-24758225ab65` started; status line showed
**plan mode on**.

## 3. Fixture: committed constraint + awaiting proposal (test seams only)

The env-guarded live fixture (`test/live-fixture.test.ts`,
`PHASE_PLAN_LIVE_FIXTURE_MODE=phase8`) drove the SAME application services the
runtime uses: DISCOVERY_COMPLETE transition, then one design_checkpoint
prepared and committed through the Phase 6 engine using the TEST-ONLY
authorization factory (`makeTestUserAuthorization` — no production surface, no
MCP mutation tool), then a second proposal left awaiting approval:

- HEAD commit `CMT-e0e4192f-8ae9-4717-bddb-8c9fcb75fc76`, snapshot
  `snap_0b784eae-c1b4-40d4-94be-fc83431c9571`
- Hard constraint `CONST-1@1` (user): "Live Phase 8 compaction validation constraint p8a"
- Awaiting `PROP-4adb1c53-99dd-4512-a248-680876b86813` @1
  (hash `sha256:b6a3eef4…92d6d08`, design_checkpoint / architecture)
- Deterministic epoch computed from the store BEFORE compaction:
  `a166e1f64b27b9af9918cc0a0abe755fa4ad4f9be286e19848cd83ed4219dffa`

## 4. get_context (live, three calls)

- The model's first spontaneous call after the bootstrap turn prompted the
  ordinary host permission dialog (read tools are not the approval bridge; only
  `approve_proposal` carries `anthropic/requiresUserInteraction`). Approved with
  "Yes" (no "don't ask again" used).
- Debug log: `Hook PreToolUse:mcp__plugin_phase-plan_phase-plan__get_context
  success` with `updatedInput._hostContext` signed — including for
  `detail: "recovery"` (the business field is hashed into the context).
  `Tool 'get_context' completed successfully` (28–34 ms).
- The model read the structured projection correctly at each stage ("Fresh run
  at discovery stage with no committed memory yet", then after the fixture:
  HEAD/constraint/awaiting all confirmed) — demonstrating the projection
  tracks Store state, not conversation.

## 5. read_memory (live)

`Hook PreToolUse:…read_memory success` →
`Tool 'read_memory' completed successfully in 34ms` for
`{kind: constraint, id: CONST-1, revision: 1, detail: full}` — the dialog
showed the exact MemoryRef; the model reported the exact statement
"Live Phase 8 compaction validation constraint p8a" with source=user,
severity=hard, status=active, compactProjection `live-constraint-p8a`.

## 6. Real compaction E2E (the §58 gate)

`/compact` executed on the real host (log: `compact: kept tail holds …`,
`[API REQUEST] /v1/messages source=compact`, `Compacted`). Immediately after:

- **`Hook SessionStart:compact (SessionStart) success`** — the host fired
  SessionStart with source=compact exactly as documented; our hook returned
  additionalContext (1119 chars).
- **Byte-identical reconstruction**: the injected text equals
  `Phase Plan active:` + the deterministic capsule + the A1 mode-recovery
  lines — verified programmatically against the fixture's pre-compaction
  capsule (both saved under `C:\Users\Administrator\phase8-live-ws\`:
  `injected-capsule.txt`, `expected-capsule-core.txt`). Same run, same
  stage/revision/goal, same HEAD commit/snapshot pair, same hard constraint,
  same awaiting proposal, same operation list.
- **Epoch unchanged**: `context_epoch=a166e1f6…dffa` in the injected capsule
  equals the fixture's pre-compaction epoch — deterministic reconstruction
  from HEAD, not from the compact summary (E20).
- **No mutation**: pre/post table counts identical (planning_runs 2,
  session_bindings 2, proposals 4, proposal_revisions 4, proposal_states 4,
  approvals 2, plan_commits 2, plan_snapshots 2, plan_heads 2,
  memory_artifacts 2, memory_revisions 2) and `PRAGMA user_version` = 5
  (E21/E22/E23/§48).
- Observed host nuance: the SessionStart:compact hook input carried
  `permission_mode != plan` (hence the A1 lines were appended — fail-visible
  by design), while the status line displayed plan mode on afterward. Read
  tools remained signed and worked either way (§39 A1 readability).

## 7. Post-compaction consistency (three independent sources)

The model's verdict, reproduced on screen: pre-compaction conversation memory,
the injected Recovery Capsule, and a fresh `get_context` call all agree — same
run, HEAD, epoch (`a166e1f6…` byte-identical across all three), constraint, and
awaiting proposal. The UserPromptSubmit epoch marker showed no staleness. The
session then exited via `/exit`; SessionEnd detached the binding
(generation 2) with the awaiting proposal preserved (legal resumable state).

## 8. Prohibitions honored

No capability-proofs file was hand-edited (no Phase 8 proof recorded — the
Phase 7 proofs remain the only recorded ones); no debug MCP mutation tools
were used (the engine commit used the test-only factory through the sanctioned
fixture seam, clearly labeled); no settings workarounds; no OAuth tokens, API
keys, cookies, host-context secrets, or private prompt transcripts are
recorded in this file; host-context tokens visible in debug logs are never
reproduced here.

## Result

| Gate (§61 "Real Claude Code") | Result |
| --- | --- |
| plugin load (hooks + 5-tool MCP) | PASS |
| /phase-plan smoke (entry → plan mode → run) | PASS |
| get_context (structured + recovery capsule) | PASS |
| read_memory (exact MemoryRef, detail=full) | PASS |
| one real compaction/recovery validation | PASS (SessionStart:compact; byte-identical capsule; epoch stable; zero store mutations) |
