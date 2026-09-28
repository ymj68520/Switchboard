# Phase 16 live validation — real-host run control (takeover / abort)

Host: Claude Code **2.1.283**, Windows 10.0.19044, Node **24.21.0**, plugin
inline `--plugin-dir D:\Programing\agent\plan-plugin\adapters\claude-code`
(dist built from the phase-16 working tree). Workspace:
`C:\Users\Administrator\phase16-live-ws` (fresh). Store: the host-managed
inline-plugin root `C:\Users\Administrator\.claude\plugins\data\phase-plan-inline\`
— the REAL production store carrying the Phase 7–15 live worlds (13 runs).

Two REAL TUI sessions drove everything (no fixture seam was needed: takeover
and abort operate on ACTIVE runs, which the production `/phase-plan` entry
creates):

- S1 `2fd50dab-e5ba-454f-bacc-3a5d74c7fc8b`
- S2 `8d197a2c-2023-4788-863e-e2b93b700a1a`

Session-scoped `--settings` hooks copy (user `settings.json` untouched:
sha256 `def5d0df9e653e122abe9a868976d31d910a32d7b3ef2e927644a2170c4d7b4c`
before and after the whole flow); `ENABLE_TOOL_SEARCH=false`; the allow list
never includes `approve_proposal`, `takeover_run`, or `abort_run`.

## Live migration 12 → 13

S1's first hook open migrated the production store `user_version 12 → 13`
(history row `run-control-authorizations` appended after
`execution-issue-successor-baseline`); every Phase 1–15 row preserved, the
control table empty. Old-writer fencing and failing-013 rollback are covered
by the automated suites (`store-migration-v13`, plus the updated v2–v10
rollback registries which now genuinely reach the supported version).

## Real takeover (§60–§61, E66/E67)

1. S1 `/phase-plan "Design a tiny URL-shortener service with two endpoints"`
   → run `plan_e4d05dad-7877-499b-81dd-6a039a3907c4` (active/discovery/
   revision 1), planning binding attached generation 1, plan mode on.
2. S2 `/phase-plan` → `selection_required` with the §13 metadata (run id,
   stage discovery/revision 1, goal, binding state/generation). The model
   presented the choice to the operator; the operator chose "take over".
3. The model called `takeover_run(run_id: plan_e4d05dad…,
   expected_binding_generation: 1)` under a signed V2 HostContext
   (`toolUseId call_50bb95b837e24ff2a2103b7d`). The REAL mandatory dialog
   appeared ("Do you want to proceed? 1. Yes" — no pre-authorization option);
   the operator answered **Yes**.
4. Store after: binding `attached`, session S2, **generation 2** (G → G+1
   exactly); run row untouched (active/discovery/**revision 1**); exactly one
   durable authorization `ctrl_99d9bd90…` / `takeover:call_50bb95b8…`
   (expected 1 → resulting 2, previous identity S1@1, new identity S2@2).
5. S2 continued the SAME planning state (E58) — it resumed the run's
   discovery conversation where S1 left off.
6. **Old-owner fencing (E67)**: S1 — still alive, still in plan mode — was
   asked to mutate. `select_section(SEC-1)` was refused verbatim on S1's
   screen: `STALE_SESSION_BINDING: no active Phase Plan run is attached to
   the current session`; its recovery attempt via `start_or_resume` hit
   `ENTRY_INTENT_INVALID` (fresh-token rule). The model reported honestly
   that the run is owned elsewhere.

## Real abort Allow (§63–§64, E69) — twice

- R1 (S2 as owner, toolUseId `call_35682340c7be423b8741666b`): mandatory
  dialog → **Yes** → run `active → aborted`, revision `1 → 2` exactly once,
  stage discovery unchanged; binding detached generation `2 → 3`; durable row
  `ctrl_59fc106e…` / `abort:call_35682340…` (expected 2 → resulting 3,
  resulting_run_revision 2, the operator's reason recorded verbatim).
- R2 (see below; toolUseId `call_b3cf3624888d42dba0dc17d6`): same chain —
  aborted/rev 2, detached gen 2, row `abort:call_b3cf3624…`.
- No FinalPlan, no ExecutionHandoff, no ExecutionBinding was created for
  either aborted run; HEAD/commits untouched; no Build authority exists
  (E38–E40/E72).

## Post-abort behavior (§66/§67/§68/§69)

- `get_context` under planning authority: no planning context (`no_active_run`
  degradation; every attempted call without a signed context failed closed
  `HOST_CONTEXT_*` — the model's fabricated tokens were all rejected).
  `get_context(detail=build)` never returned a Build payload — abort is not a
  handoff (E47).
- Harmless host tools kept working (Read answered normally) (§66).
- Real `/compact` after abort: the aborted run was NOT reattached (binding
  still detached gen 3) and no planning capsule for it was injected (§68).
- `/exit` (SessionEnd) after abort: generation stayed 3 — idempotent, no
  second bump (§69; verified again for R2/gen 2 at the end of the run).
- `/phase-plan` after abort: a NEW ordinary run
  `plan_eb7f27e5-8fae-403c-8191-c648bbf210d6` (active/discovery/rev 1) —
  the aborted run unchanged, never a successor baseline (E73).

## Real Deny semantics (§62/§42, E68/E70)

- **Abort Deny (E70)**: on R2, `abort_run` reached the mandatory dialog
  (toolUseId `call_57da682c4b2b4521a3995ffe`); the operator answered
  **Esc/No** → the tool was interrupted and never executed: run still
  active/revision 1, binding still attached generation 1, authorization row
  ABSENT, plan mode unchanged.
- **Takeover Deny (E68)**: S1 `/phase-plan` → `selection_required` listing
  S2's R2 → model called `takeover_run(plan_eb7f27e5…, generation 1)` →
  mandatory dialog → **Esc/No** → zero mutation: R2 still active/rev 1,
  binding still S2@1, no new authorization row.

Final control table: exactly THREE rows — one per human-authorized operation
(`takeover:call_50bb95b8…`, `abort:call_35682340…`, `abort:call_b3cf3624…`);
the two denied dialogs left no rows.

## §38 host probe — combined authorization + mode transition

With the PermissionRequest hook matched for `abort_run` (after the
live-found matcher fix), the REAL chain was captured in the host debug log:

```
PreToolUse abort_run  → permissionDecision "ask" (+ signed updatedInput)
PermissionRequest     → {"decision":{"behavior":"allow",
                        "updatedPermissions":[
                          {"type":"setMode","mode":"default","destination":"session"}]}}
host                  → MANDATORY DIALOG STILL SHOWN  (A ✓)
operator Yes          → handler executed              (C ✓)
operator No  (2nd run)→ handler never executed, zero mutation (D ✓)
after Yes             → setMode NOT applied           (B ✗)
```

The host applies neither the dialog suppression (good — mandatory interaction
survives) nor the `updatedPermissions` (the session stayed in effective plan
mode: the model itself declined a Write probe "would violate that
restriction", and the status line kept `plan mode on`). The same
`updatedPermissions` shape applied fine for `start_or_resume` (a tool without
`requiresUserInteraction`) — the host drops it specifically on the
interactive path.

Per directive §40 this is reported, not worked around:

**ARCHITECTURE_BLOCKER_ABORT_HOST_AUTH_MODE_TRANSITION**

Phase 16 therefore closes as PARTIAL on exactly two exit gates (E43, E71);
every other gate is green. The abort remains fully safe: real mandatory
authorization, durable idempotent authority, zero mutation on deny, terminal
immutable history, no Build. Only the automatic session-scoped mode exit is
missing until the host applies `updatedPermissions` alongside
`requiresUserInteraction` (or offers an equivalent single-chain primitive).

No OAuth/token/HostContext signatures/private transcript content is recorded
here. No settings/account changes, no nested Claude, no simulated modes; the
forbidden §40 workarounds were never used.
