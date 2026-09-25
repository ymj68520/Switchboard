# Architecture Amendment A1 — Plan Mode Recovery Semantics

Status: **ADOPTED** (supersedes the corresponding v0.1 recovery semantics in the consolidated
architecture specification)
Applies to: `docs/claudecode/spec/claude-code-phase-plan-v0.1-architecture-spec.md`
Effective baseline: Phase 7 implementation commit `1071289` (`feat(claude): add host context
authority bridge`), which this amendment does **not** rewrite.

---

## 1. Reason

Phase 7 produced the factual answer to the mandatory recovery gate: current documented Claude
Code behavior cannot restore Claude Plan Mode automatically on an interactive exact-session
`/resume`. The frozen v0.1 semantics assumed it could. This is a **host capability mismatch**,
not a Phase Plan implementation defect, and is recorded here as an architectural input.

## 2. Official host constraint

Documented Claude Code behavior (verified against installed 2.1.276, official sessions/hooks
documentation):

```text
resume session
    ↓
conversation/model/session state restored
    ↓
permission mode normally restored
    ↓
EXCEPT:
    plan is never restored on the interactive terminal path
```

- Interactive terminal resume (`claude --resume <id>` / `--continue`): plan is the documented
  exception — the session starts in "the permission mode a new session would start in".
- `/resume` inside a live session keeps the current session's mode; the launch session picker
  starts in the new-session mode.
- The only documented plan-restore paths are non-interactive `claude -p --resume` **with**
  `--permission-prompt-tool` (v2.1.246+) and the VS Code path — neither is the interactive
  `/resume` UX Phase Plan requires.
- `SessionStart` cannot set the permission mode: its documented output surface
  (`additionalContext`, `sessionTitle`, `reloadSkills`, env-file) contains no permission
  mechanism; `PermissionRequest` can only change mode during an actual permission decision.

Session-scoped `setMode(plan, destination=session)` through the `PermissionRequest` hook
remains available — it is how Phase 7's `/phase-plan` re-entry restores Plan Mode.

## 3. Old invariant (removed/replaced)

```text
Exact-session /resume automatically reattaches the bound PlanningRun
AND restores Plan Mode.
```

Spec locations replaced: §23.4 `/resume` (the recovery list included `Plan Mode`), and the
implied guarantee in §6/§14.3 that resume returns the session to a planning-capable mode.

## 4. New invariant (frozen)

Planning state recovery and host execution-mode recovery are distinct operations:

```text
/resume
    ↓
recover exact Phase Plan authoritative state
    ↓
reattach exact-session PlanningRun when legal
    ↓
inspect current Claude permission mode

if permission_mode == plan:
    planning may continue

if permission_mode != plan:
    mode recovery is required
    ↓
    block ordinary Phase Plan continuation (fail-closed)
    ↓
    user explicitly invokes /phase-plan
    ↓
    existing EntryIntent / HostContext path
    ↓
    start_or_resume returns the SAME PlanningRun
    ↓
    PermissionRequest setMode(plan, session)
    ↓
    planning continues
```

Frozen as **RI-22** and **CC-11** in the consolidated spec (§39):

> **RI-22** — PlanningRun recovery and Claude permission-mode recovery are distinct operations.
> An exact-session resume may recover/reattach authoritative PlanningRun state even when the
> host does not restore Plan Mode. If the current host permission mode is not plan, no planning
> continuation or planning mutation is authorized until the user explicitly invokes
> `/phase-plan` and the documented session-scoped Plan Mode transition succeeds.

> **CC-11** — Phase Plan never persists Claude Plan Mode into user, project, or local settings
> solely to survive session resume. Where the host cannot restore Plan Mode, explicit
> `/phase-plan` re-entry is the recovery mechanism.

Key distinctions carried by the amendment:

- **No new PlanningRun.** Mode recovery re-enters run R via `start_or_resume`; it must not
  create, duplicate, supersede, or reset R.
- **No new planning authorization.** Re-entry is host-mode recovery authorization, not
  Proposal Approval / PlanCommit Approval / Final Approval / takeover. Committed design stays
  committed; an awaiting Proposal stays awaiting; no reapproval is caused by the host dropping
  Plan Mode.
- **Explicit user intent remains required.** Only a user-invoked `/phase-plan` (fresh signed
  `EntryIntentV1`) may trigger mode recovery. SessionStart, model inference, the MCP process
  environment, and conversation text can never trigger it.
- **Derived, not persisted.** No `mode_recovery_required` lifecycle/state is added; the
  condition is derived from `active PlanningRun + current session ownership + permission_mode
  != plan`. No schema migration.
- **No settings workaround.** Mode restoration stays session-scoped, documented, host-native
  (CC-11).

## 5. Affected spec sections (edited in the consolidated spec)

- §6 Claude Plan Mode Integration — new §6.5 "Plan Mode recovery after resume"
- §14.3 Recovery Context Capsule — mode-recovery indication when `permission_mode != plan`
- §23.4 `/resume` — recovery list no longer includes Plan Mode; amended semantics recorded
- §23.3 — unchanged (already correct)
- §39 Core Invariants — RI-22 / CC-11 appended under an Amendment A1 heading
- §43 v0.1 Exit Gate — recovery-test list gains the A1 guarded-resume chain

## 6. Unaffected invariants

This amendment does not weaken, and explicitly preserves:

```text
/clear does not transfer ownership
fork does not inherit writable ownership
new session does not auto-attach by workspace similarity
takeover remains explicit and generation-fenced
generation fencing remains authoritative
Plan Mode is the host execution boundary (§6.1)
the model cannot decide on its own to enter Phase Plan
drift guards remain fail-closed (§6.3)
approval/commit immutability and all Phase 6 transaction semantics
schema v5 and canonical Plan Memory contents (host runtime state stays out)
```

Only exact-session recovery semantics change.

## 7. Effective baseline

```text
713d831 → 5b8b755 → 932d66f → 6d0b37b → 15934cab → ca7476ed → 6f0def0 → 0301309 → 2aeabd0 → 1071289
```

Amendment adopted after Phase 7 disposition `PARTIAL —
ARCHITECTURE_BLOCKER_PLAN_MODE_RESUME`. With A1 applied, that blocker is considered
**resolved by architecture adaptation**. Phase 7 remains
`PARTIAL — IMPLEMENTATION COMPLETE, LIVE HOST VALIDATION PENDING` until the authenticated-host
E2E probe succeeds; only then `FROZEN / PASS`.
