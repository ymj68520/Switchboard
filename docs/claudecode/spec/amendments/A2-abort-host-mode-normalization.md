# Architecture Amendment A2 — Abort Lifecycle vs Host Permission-Mode Normalization

Status: **ADOPTED** (supersedes the abort mode-exit semantics of Phase 16 / consolidated
specification §24; resolves the Phase 16 disposition blocker
`ARCHITECTURE_BLOCKER_ABORT_HOST_AUTH_MODE_TRANSITION` by architecture adaptation)
Applies to: `docs/claudecode/spec/claude-code-phase-plan-v0.1-architecture-spec.md`
Effective baseline: Phase 16 commits `8d4033d` (`feat(claude): add planning run takeover and
abort controls`) + `22d0c80` + `f48369c`, which this amendment does **not** rewrite.

Scope guard: A2 changes ONLY the relationship between the Abort lifecycle and the Claude
host permission mode. It does not modify takeover semantics, abort authorization, the abort
terminal lifecycle, binding fencing, Plan Memory, FinalPlan, ExecutionHandoff,
ExecutionBinding, the 18-tool MCP surface, or schema v13.

---

## 1. Reason

Phase 16's mandatory real-host probe (§38) produced the factual answer on Claude Code
2.1.283: the host preserves the mandatory authorization dialog for
`requiresUserInteraction` tools (probe A/C/D all passed) but **drops
`updatedPermissions` on that interactive path** — after the user authorizes with Yes, the
`setMode(default, destination=session)` request carried by the PermissionRequest allow is
never applied and the session remains in Plan Mode (probe B failed).

The frozen Phase 16 semantics treated "abort exits Plan Mode" as part of Abort correctness,
which made an otherwise fully safe, fully human-authorized abort a §40 architecture
blocker. That conflation is wrong: the abort lifecycle is Core authority; the permission
mode is host UI state. This amendment separates them, exactly as Amendment A1 separated
PlanningRun recovery from permission-mode recovery.

## 2. Official host constraint (observed, Claude Code 2.1.283)

```text
abort_run (requiresUserInteraction=true)
    ↓
PermissionRequest hook returns allow + setMode(default, destination=session)
    ↓
mandatory human dialog still appears            (probe A: PASS)
    ↓
user Yes
    ↓
abort handler executes                          (probe C: PASS)
    ↓
PlanningRun becomes aborted, binding detached   (terminal, durable)
    ↓
updatedPermissions is NOT applied               (probe B: FAIL)
    ↓
host remains in Plan Mode
```

Verified against the real TUI and the debug log (see the Phase 16 validation record).
This fact is version-specific and is NOT generalized to future hosts: A2 supports both
host behaviors (§30 of the adopting directive) — a host that applies
`setMode(default, session)` after mandatory approval records "automatic normalization
supported" and the A2 fallback simply never fires.

Forbidden workarounds (unchanged from Phase 16 §40): removing
`requiresUserInteraction`, auto-authorizing abort, persisting `defaultMode`, settings
writes, `bypassPermissions`, fake approvals, raw DB mutation, silent auto-allow.

## 3. Authority separation (frozen)

```text
Abort lifecycle termination  !=  Claude host permission-mode normalization
```

- `PlanningRun.lifecycle = aborted` is decided by Phase Plan Core/Store.
- The host `permission_mode` is decided by the Claude Code runtime.

Neither state owns the other. RI-23 freezes this.

## 4. Revised abort semantics

Old (replaced):

```text
Abort → aborted → exits Plan Mode
```

New:

```text
explicit human-authorized Abort
    ↓
PlanningRun = aborted, binding invalidated
    ↓
Phase Plan requests a session-scoped exit from Plan Mode
    ↓
if host applies it:  permission_mode = default
else:                abort remains fully committed;
                     host-mode normalization is explicitly required
```

The abort stays atomic from the Phase Plan perspective (A2 §4): the same Store
transaction still performs `active → aborted`, `revision +1` exactly once, detach with
`generation +1`, and the durable `run_control_authorizations` row. The transaction's
success IS "Abort complete". A host still showing Plan Mode must never cause a rollback,
reactivation, re-attach, or "abort pending" state — none of those states exist.

`abort_mode_exit_required` is a **derived host-runtime condition** (A2 §5), true when:
last successful operation = `abort_run` AND the PlanningRun became aborted AND the
observed `permission_mode == plan`. It is never persisted: no DB column, no lifecycle
state, no schema version, no `abort_pending` (A2 §6/§17 — the Store must not claim to
know the session's mode across restarts).

## 5. Implementation alignment (A2 §26 — the ONLY behavioral change)

```text
successful abort PostToolUse
    ↓
inspect host permission_mode
    ↓
if still plan: inject the frozen fail-visible normalization notice
```

- `PostToolUse` for `abort_run` parses the delivered tool response (bootstrap envelope)
  for a successful (including idempotent) abort and observes `permission_mode` from the
  hook input. Positive plan observation → `additionalContext` with the frozen A2 notice;
  absent/non-plan mode or non-success response → nothing. The observer is store-free by
  construction (RI-23: the abort already committed in the MCP transaction).
- No new MCP tool. No new Store mutation. No migration. No new authorization row.

The frozen notice (A2 §10):

```text
Phase Plan has been aborted successfully.

The PlanningRun is terminal and no writable Phase Plan authority remains.

Claude Code did not leave Plan Mode automatically.
Use Claude Code's normal permission-mode control to return this session to default/manual mode if you want to continue ordinary non-Phase-Plan work.

This is host-mode normalization only. It does not resume, complete, or start a Phase Plan Build.
```

Tool result semantics (A2 §27): the `abort_run` response reports
`mode_exit: "requested"` — abort committed, mode exit **requested** — and never claims
the mode changed. Actual mode success is observed later by hook input.

The `PermissionRequest` hook continues to return
`setMode(default, destination=session)` after full re-verification (A2 §7): it is a
**best-effort host normalization request**, never an Abort correctness prerequisite.
Future hosts that honor it get automatic normalization; the A2 fallback supports hosts
that do not. Mandatory interaction stays non-negotiable (A2 §8): human authorization
always outranks automatic mode normalization, and `requiresUserInteraction=true` is never
weakened to make the mode switch work.

## 6. What deliberately stays true

- **No ExitPlanMode automation (A2 §11)** — Phase Plan never calls ExitPlanMode after
  abort; it belongs to Claude's plan UX and can read as "approve this plan / begin
  implementation", the opposite of Abort.
- **User mode change is not another authorization (A2 §12)** — the user switching
  plan → default/manual through Claude's own UI afterwards is host-mode normalization
  only; it is not a second Abort approval, Final Approval, Build authorization, or
  ExecutionHandoff.
- **No Build authority (A2 §13/§14)** — even after a manual mode exit there is no
  FinalPlan-derived Build authority, ExecutionHandoff, or ExecutionBinding;
  `get_context(detail=build)` keeps returning `EXECUTION_CONTEXT_NOT_AVAILABLE`. Ordinary
  host work after normalization is Claude's own permission system at work — it is not
  "Phase Plan Build".
- **Aborted runs never return (A2 §15)** — a host still in Plan Mode cannot cause
  SessionStart, `/compact`, or `/resume` to re-attach an aborted run; Phase 16's proven
  terminal semantics are untouched.
- **`/phase-plan` remains explicit (A2 §16)** — re-planning requires a fresh `/phase-plan`
  and creates a new ordinary PlanningRun, never a resume or successor of the aborted run.
- **No persistent recovery state (A2 §17/§18)** — after a session restart the aborted run
  remains terminal and Phase Plan recovers no mode state; the new session starts in the
  host's own default mode. One compact warning per turn maximum if a hook still observes
  plan mode after a successful abort (A2 §19); the marker itself is memory/turn-level
  (A2 §20) and the v0.1 implementation confines it to the abort PostToolUse observation.

## 7. New invariants (frozen in consolidated spec §39)

> **RI-23** — PlanningRun abort and Claude permission-mode normalization are distinct
> operations. A human-authorized Abort becomes authoritative when the Core commits
> `lifecycle=aborted` and invalidates writable ownership. If the host cannot apply the
> requested session-scoped transition out of Plan Mode on the mandatory-interaction path,
> Phase Plan must preserve the Abort, expose the host-mode mismatch, and must not weaken
> the human-authorization boundary to repair it.

> **CC-12** — Phase Plan never persists Claude permission settings merely to normalize the
> host after Abort. When the current Claude host cannot atomically combine mandatory MCP
> interaction with session-scoped `setMode(default)`, Abort remains terminal and the
> remaining host-mode transition is an explicit host UX action.

## 8. Affected spec sections (edited in the consolidated spec)

- §24 Abort Semantics — "Abort exits planning mode but does not automatically begin
  Build." replaced by the A2 wording (abort terminates Phase Plan authority immediately;
  the adapter requests a session-scoped transition; when the host cannot apply it the
  Abort remains authoritative and host-mode normalization is reported as still required;
  leaving Plan Mode creates no Build authority/ExecutionHandoff/ExecutionBinding)
- §39 Core Invariants — RI-23 / CC-12 appended under an Amendment A2 heading

## 9. Unaffected invariants

```text
takeover semantics (generation fencing, SESSION_ALREADY_BOUND, handoff boundary)
abort authorization (mandatory dialog, V2 attestation, main-session only)
abort terminal lifecycle (never reactivated, idempotent replay, wholesale history)
binding fencing (detach +1, STALE_SESSION_BINDING / BINDING_DETACHED refusals)
Plan Memory / FinalPlan / ExecutionHandoff / ExecutionBinding semantics
18-tool MCP surface and schema v13 (SUPPORTED_SCHEMA_VERSION stays 13)
Phase 16 §40 forbidden-workaround list
```

## 10. Exit-gate reinterpretation

Phase 16 gates E43/E71 are replaced by E43-A2/E71-A2:

> **E43-A2** — Abort requests session-scoped host-mode normalization without weakening
> mandatory human authorization. If the host applies it, the session exits Plan Mode. If
> the host does not apply it, Abort remains terminal and Phase Plan exposes
> `abort_mode_exit_required` without settings writes or silent workaround.

> **E71-A2** — The real host proves one of: (A) automatic session-scoped mode exit
> succeeds; or (B) the host refuses/drops that transition, Phase Plan detects the
> mismatch, exposes it fail-visibly, preserves the terminal Abort, and the user can
> normalize the host mode explicitly without creating Build authority.

Phase 16's existing live evidence already proves the authorization, terminality, fencing,
immutability, and settings-unchanged facts; only the A2-specific host closure (observer
fires on the real host, explicit user normalization observed, post-normalization
confirmations) is new work.

## 11. Revised Phase 16 freeze gate

After A2:

```text
Takeover:                                PASS
Abort human authorization:               PASS
Abort terminal Core transition:          PASS
Abort binding fencing:                   PASS
Abort no-Build semantics:                PASS
Automatic host mode exit:                unsupported on Claude Code 2.1.283 (documented host fact, §30 branch B)
A2 fail-visible host normalization:      PASS (live closure 2026-09-28, see §12)
```

With the live A2 closure recorded, Phase 16 is **FROZEN / PASS under Architecture
Amendment A2** and becomes the v0.1 feature-complete baseline. The Phase 16 disposition
blocker `ARCHITECTURE_BLOCKER_ABORT_HOST_AUTH_MODE_TRANSITION` is resolved by
architecture adaptation (the same path A1 took for Phase 7).

## 12. Live A2 closure (2026-09-28, Claude Code 2.1.283, real TUI)

Host version re-verified at run time (§30): still 2.1.283 → branch B. Two active runs,
two mandatory dialogs, two Yes authorizations:

- Abort 1 `plan_11e7e4bc…` → aborted rev 2, binding detached gen 2, control row
  `ctrl_474f5301…`; PostToolUse input captured verbatim — `permission_mode: "plan"`
  present on the real PostToolUse input; host stayed in Plan Mode (probe B fact);
  the 415-char frozen notice was injected (`additionalContext`, debug-log verbatim)
  and the model exposed the mismatch fail-visibly.
- Operator normalization via Shift+Tab → `auto mode` (host's own control).
- Second attempt after normalization: fail-closed `HOST_CONTEXT_REQUIRED` with
  `_hostContext: ""`, zero mutation; PostToolUse does not fire for MCP error results
  on 2.1.283 (host fact) — no notice, matching §28's deny path.
- Abort 2 `plan_4bc80e13…` after `/phase-plan` mode recovery → aborted rev 2, detached
  gen 2, control row `ctrl_a7927ef8…`; capture line #2 `permission_mode: "plan"`,
  second notice emission — reproducible.
- Drift-guard evidence: with a run attached and the host normalized out of Plan Mode,
  the UserPromptSubmit drift guard blocked the prompt itself (`DRIFT_GUARD_REASON`) —
  a real hook positively observing `permission_mode != plan`. Consequence: an abort
  outside Plan Mode is unreachable BY DESIGN; the mismatch is forced through
  `/phase-plan` recovery first.
- Confirmations: both runs unchanged; zero execution handoffs/bindings/final plans for
  both runs (no Build authority); user settings sha256 `def5d0df…` byte-identical
  (CC-12); no ExitPlanMode automation.

Live-found implementation fact: the plugin `hooks.json` PostToolUse matchers lacked
`abort_run` — without it the A2 observer silently never fires (same bug class as the
Phase 16 PermissionRequest matcher gap). Fixed and pinned in the assets test.

Full record: `docs/claudecode/validation/phase-16-run-control-live-validation.md`
(A2 section; the original §38 blocker evidence is preserved verbatim there).
