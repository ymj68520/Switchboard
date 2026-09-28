# R3b — Abort Authority Hardening Report (RF-02)

**Task:** RF-02 Abort Authority Hardening (closure brief §1–§19). **Status: RESOLVED — PASS.**
**Companion records:** `r3-approval-authority-hardening-report.md` (RF-01, frozen) · `v0.1-rc-validation.md` (candidate identity, live logs) · `v0.1-release-freeze-report.md` (disposition).

---

## 1. Discovery

During the 2026-09-28 (late) re-inspection for the Final RC completion brief, a scope note was recorded: while RF-01 hardened the Proposal-approval ask, the **terminal-abort confirmation** (`ultraplan_request_abort`) still issued `ToolContext.ask` with `patterns: []`. By the already-proven host semantics (RF-01 audit §2.1), an empty patterns list skips permission-rule evaluation entirely — an **implicit allow under every configuration**. `abortRun` could therefore execute without a human confirmation, defeating the frozen R1 abort contract. The prior session deliberately left it unchanged (the then-active brief forbade approval-surface changes); this brief authorized the fix as RF-02.

## 2. R1 Frozen Abort Contract (authoritative, unchanged)

`ultraplan_request_abort` takes zero authority-bearing model args → the Harness resolves the active run and validates abortability (`beginAbort`) → a REAL one-shot `ToolContext.ask` pends → human **Allow** → `abortRun`: `lifecycle = aborted`, `activeWork` cleared, one `run.lifecycle_changed` event, terminal. **Deny** must leave `lifecycle`, `stage`, `activeWork`, HEAD, FinalPlan, and handoff unchanged. Abort never PlanCommits, never moves HEAD, never produces a FinalPlan, never hands off. Post-abort, `/ultra-plan` requires a fresh admission and creates a NEW PlanningRun (R1 deadlock-escape semantics preserved).

## 3. Root cause (confirmed, not re-investigated)

The abort call site (registry.ts, `ultraplan_request_abort`) used:

```text
permission: ultraplan.abort.<PlanID>     (Harness-derived in controller.beginAbort)
patterns:   []                            ← the defect: zero evaluation iterations
always:     []
```

Host behavior is the RF-01-audited one: `ask()` evaluates rules only inside its loop over `patterns`; `[]` resolves immediately as an implicit allow regardless of any rule or user configuration.

## 4. Chosen fix (narrow, mirrors RF-01 under the abort's own namespace)

1. **registry.ts** — the ask now carries `patterns: [<active PlanID>]` (the Harness-derived exact run identity — the user can see WHICH run is being terminated; the model supplies nothing). `always` remains **empty** (`[]`) — one confirmation never becomes standing abort authority. The public permission prefix `ultraplan.abort.` is the pre-existing R1 naming and was NOT renamed.
2. **opencode-plugin.ts (`applyToConfig`)** — the forced rule set becomes:
   - agent-scoped (ultraplan agent definition): `"ultraplan.approval:*": "ask"` **plus** `"ultraplan.abort.*": "ask"`
   - resolved global config layer: both keys delete-then-re-appended **LAST** (last-match `findLast` resolution outranks any earlier wildcard, including a user-level `"*": "allow"`)
   - every unrelated user permission preserved verbatim. No user-written permission block is required.

## 5. Config enforcement (deterministic proof)

`r3b-abort-authority-hardening.test.ts` (10 tests) + the updated `r3-approval-hardening.test.ts`: default config forces both rules at BOTH layers; unrelated permissions (`bash`, `edit`, `webfetch`, `external_directory`, nested `read`) preserved verbatim; explicit user `"ultraplan.abort.*": "allow"` is overridden to `ask`; both rules appended after a user `"*": "allow"` (last two keys); idempotent across repeated application; command/agent registration unchanged.

## 6. Deterministic tests (§8)

650/650 across 25 files (was 640; +10 new). New coverage: exact ask binding (`permission === ultraplan.abort.<runID>`, `patterns === [runID]`, `always === []`, metadata `kind: ultraplan.run-abort`, `oneShot: true`, `planID`); deny → run object field-identical (lifecycle, stage, activeWork, headCommit, headSnapshot), commit count unchanged, ZERO new events; allow → `lifecycle=aborted`, `activeWork` cleared, exactly ONE new event and it is `run.lifecycle_changed` `active→aborted`, HEAD/commits untouched, no handoff/finalization event anywhere in the log, `findActiveRunBySession` empty; fresh admission after abort creates a NEW run id and the aborted run stays terminal. Gates: typecheck 0, lint 0, build 0, `smoke:opencode-handoff-det` **19/19 first-run zero-retry** on the RF-02 dist.

## 7. Live OpenCode proof (§9–§14) — OpenCode 1.18.32 · Node 24.21.0 · Windows

Environment: fresh disposable consumer `%TEMP%\rr3b-consumer` (tiny fixture, plugin installed from the exact RF-02 artifact tarball, `opencode.json` with **NO permission block**), isolated `ULTRA_PLAN_DATA_DIR`, primary TUI. Runs driven through the normal model-visible path (chat message → model calls `ultraplan_request_abort`). Binary self-updated to 1.18.33 twice during the window and was re-pinned to 1.18.32 both times before host work.

| Leg | Host log | Pend | Human decision (attested) | Store proof |
|---|---|---|---|---|
| PLAN-001 Allow | `evaluated permission=ultraplan.abort.PLAN-001 pattern=PLAN-001 action.permission=ultraplan.abort.* action.action=ask` → `asking id=per_0e806797f0018wUwXnqKXnS37r patterns=["PLAN-001"]` (12:38:53.567Z) | **46 s**, dialog visible ("Call tool ultraplan.abort.PLAN-001" — Allow once / Allow always / Reject), no auto-resolution | **Allow once** — user attested | `lifecycle=aborted`, revision 2, exactly one new event `seq=4 run.lifecycle_changed → aborted`, `headSnapshot=SNAP-001` unchanged, 0 commits, no handoff |
| PLAN-002 Allow | `evaluated … PLAN-002 … action.action=ask` → `asking id=per_0e81dae6f001306vTITEqY4ofY` (13:04:14.447Z) | **~25 s**, no auto-resolution | **Allow once** — user attested | same terminal shape as PLAN-001 |
| PLAN-003 Deny | `evaluated … PLAN-003 … action.action=ask` → `asking id=per_0e821f3ef001JdVtrYvkaJNjEo` (13:08:54.383Z) | pending until human acted | **Reject** — user attested | **nothing changed**: `active`/discovery, revision 1, still 3 events (no lifecycle event), HEAD unchanged; TUI rendered "The user DENIED the abort; run PLAN-003 remains active (stage discovery). Nothing changed." |

- **No auto-resolution**: three independent dialogs pended 25–60 s under the DEFAULT host configuration; the ONLY resolutions were attested human clicks. The pre-fix behavior (immediate implicit allow) is gone.
- **Fresh-run admission (§12)**: after each abort, `/ultra-plan` admitted a NEW run (PLAN-001→PLAN-002→PLAN-003, all in session `ses_f17fa594cffew33bHVkJosjoE1`); aborted runs stayed terminal and never resumed.
- **Computer Use boundary (§14)**: Computer Use launched/navigated the TUI, dispatched commands, and captured screenshots only. Every authority-bearing click (Allow ×2, Reject ×1) was performed by the human user and attested afterwards. The planned order was Deny-first; two Allows landed first because the user clicked ahead of instruction — each was immediately attested and recorded as valid Allow-leg evidence, and the Deny leg was then executed explicitly.

## 8. Environment incidents during the live window (provenance, nothing erased)

- OpenCode self-updated to 1.18.33 **twice more** in this window (4th and 5th overall); re-pinned to 1.18.32 each time before any host work.
- The user reconfigured providers mid-run: the hcnsec gateway (models `MiMo-V2.6-Flash`, `step-5-preview`) appeared in the model picker. Both hcnsec models failed to drive the tool loop (empty-turn loops emitting repeated context-trace blocks, no tool calls — interrupted both times); the free-tier Ling model hit Console rate limits mid-window. The abort legs ran on `opencode/ling-3.0-flash-fin-free` (PLAN-001) and `opencode/nemotron-3.5-lightning-free` (PLAN-002/003) — model identity is irrelevant to the authority mechanism, which is host-side.
- A dead RF-01-era TUI console was closed before the run; the parked rr3 acceptance run was NOT used (§13) — all RF-02 legs ran in the disposable rr3b-consumer.

## 9. Release impact

Production files changed: `adapters/opencode/src/tools/registry.ts` (ask shape), `adapters/opencode/src/runtime/opencode-plugin.ts` (forced rules). Therefore the pre-RF-02 identities are superseded:

```text
PACKAGE_CONTENT_SHA (RF-02 fix commit)
3a71b9c51ff652f33560e39217a10cdea3766a5d

ARTIFACT switchboard-opencode-0.1.0.tgz
SHA-256 4c6a244d1f94a533cac75e546c5a4390a256330da1420433ffb4fac0287531be
397,511 bytes; installed into the fresh consumer and verified:
import OK, config hook registers /ultra-plan + ultraplan agent,
both forced rules present at global AND agent scope, unrelated
permissions untouched; RF-02 code confirmed in the installed dist.
```

RF-01 evidence (tainted run, default-config proof, four human Proposal approvals, section-scope trace) is orthogonal and carried forward unchanged — this fix only ADDS the abort rule alongside the approval rule. The frozen R1 abort contract is unchanged and now actually enforced by the host.

**Final RF-02 result: PASS** (deterministic + live Deny/Allow/terminal/fresh-run proofs above).
