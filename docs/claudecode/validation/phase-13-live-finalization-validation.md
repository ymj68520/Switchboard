# Phase 13 live validation — deterministic finalization + Final Plan authorization

Host: Claude Code **2.1.283**, Windows 10.0.19044, Node **24.21.0**, plugin
inline `--plugin-dir D:\Programing\agent\plan-plugin\adapters\claude-code`
(dist built from the phase-13 working tree). Workspaces: fresh
`C:\Users\Administrator\phase13-live-ws` (run A) and
`C:\Users\Administrator\phase13-live-ws2` (run B). Store: the host-managed
inline-plugin root `C:\Users\Administrator\.claude\plugins\data\phase-plan-inline\`
— the REAL data shared with the Phase 7–12 live runs.

## §92–§94 — live migration 9 → 10, backup/rollback/fencing

The shared host store was at `user_version` **9** when the Phase 13 binary
first loaded; the plugin's own migration path advanced it to **10** (history
row `finalization-final-plan` appended after `synthesis-validation-foundation`),
creating the six finalization tables empty and preserving every prior row —
including the Phase 11/12 legacy runs and the Phase 12 synthesis run
(`plan_84387626…`, stage synthesis, still failing closed with no fabricated
input). Old-writer fencing (`STORE_SCHEMA_TOO_NEW` at version 11) and
failing-010 rollback are covered by the automated migration suites
(`store-migration-v*`, `store-migrations`, `store-inspect`, `store-multiprocess`).

## §103 — real-host request_finalization (run A)

Session 1 (`835a7bf4-6d6c…`) started run
`plan_0b19abed-d1c0-4634-bc30-1e2f6a96df76` through the real `/phase-plan`
chain (entry intent → `start_or_resume` → plan mode on). The sanctioned
fixture seam (`live-fixture.test.ts` mode `phase13`) drove it through the real
domain path to **stage validation, revision 8** with frozen input
`synin_77469d04…` and a **clean** report `valrep_98f68400…`. The Recovery
Capsule **v4** rendered with the new `Finalization: (not at final stage)`
segment and `request_finalization` in Available operations.

The real host model then called `get_context(detail=validation)` (permission
dialog → Allow) and **`request_finalization`** (permission dialog → Allow).
Verified in the store immediately after:

- run stage **validation → final**, revision **8 → 9** (+1 exactly once),
  lifecycle active;
- candidate `fpc_bbff969a-e89f-4c79-bd45-078ccdcdf36b` (seq 1, hash
  `sha256:21f5874f…4464e3`), request id `finalize:call_8c24af99892b47049d78937b`
  — derived from the SIGNED host toolUseId;
- pre-approval audit `evaud_821f2903…` (purpose `pre_approval`);
- final proposal `PROP-a47fdf08…@1` type `final_plan` awaiting with hash
  `sha256:2c16a895…234197`;
- HEAD **unchanged** (`CMT-1d983ef4…`), zero new commits.

## §106 — compaction recovery at final-awaiting

Real `/compact` at final-awaiting; the compacted session answered from the
recovery context ONLY (window title: "Phase Plan recovery context"): candidate
`fpc_bbff969a…` + exact hash, proposal `PROP-a47fdf08…@1` + exact hash +
awaiting status, stage final (revision 9), handoff not delivered — all
byte-identical with the store.

## §104 — real human Final Approval + Final PlanCommit

The model presented the candidate (get_context detail=final + the Markdown
projection, "Markdown is a projection only"), then called
**`approve_proposal(PROP-a47fdf08…, 1, sha256:2c16a895…)`**. The REAL
requiresUserInteraction dialog appeared ("This tool always requires explicit
human approval and cannot be pre-authorized") and the operator pressed
**Allow**. The commit-time FinalizationGate rerun executed inside the real
authorization transaction and passed; verified in the store:

- FinalPlan `fplan_cdf2e6ad-5f44-4ccb-90d1-917402c605a6` revision 1, provenance
  candidate `fpc_bbff969a…` → proposal `PROP-a47fdf08…` → approval
  `APPR-9c3391e4…` → commit `CMT-e0136202…` → snapshot `snap_fe1d8ca5…`;
- **commit-time** audit `evaud_62a1a28a…` (purpose `commit_time`, bound to the
  candidate) — NOT the pre-approval snapshot (§34/E50);
- exactly one new PlanCommit; HEAD advanced exactly once;
- **zero-design-change snapshot**: `snapshot_members` of
  `snap_fe1d8ca5…` byte-equal to the candidate base HEAD `snap_eebab0d4…`
  (3 members) with a new snapshot/commit id (§51);
- run revision **still 9**, stage **still final**, lifecycle active (§52/§58);
- `PLAN_COMMITTED` audit payload carries the final fields with
  `committedRefs: []` (§79).

## §107 — post-approval recovery before handoff

Real `/compact` AFTER approval; from the capsule only the model reported:
"Final Plan approved: Yes — fplan_cdf2e6ad…", "Handoff authorized: Yes",
"Execution handoff delivered: No", and explicitly refused to exit Plan Mode
(the capsule's approved-segment wording "Handoff authorized. / Execution
handoff has not yet been delivered." is on screen).

## §60/§108 — ExitPlanMode remains denied (live)

The model was asked to call ExitPlanMode; the real PreToolUse hook blocked it:

```
Error: PreToolUse:ExitPlanMode hook error: Phase Plan has not completed Final
Approval/Handoff. The PlanningRun is still active; ExitPlanMode cannot end it.
```

— shown verbatim on screen for the APPROVED-FinalPlan run. Plan Mode stayed
on; the run stayed active at stage final. No handoff/build surface exists.

## §105 — real-host stale-candidate rejection (run B)

Session 2 (`1f1825c3-2951…`, fresh workspace `phase13-live-ws2`) started run
`plan_62ed092d-c2df-443a-9273-73a89fd75ce4`. The fixture (mode
`phase13-drift`) promoted a **critical fingerprint Evidence**
`ev_2fff221f…@1` over `phase-plan-live-drift.txt` ("LIVE DRIFT SOURCE v1"),
brought it into the frozen scope through a real committed decision proposal
(`requiredEvidence`), re-completed both Sections to a new input, submitted the
manifest + clean report, and froze candidate `fpc_f073ca4c…` + final proposal
`PROP-33c9cdef…@1` (hash `sha256:6f546ff8…`) at stage final, revision 14 —
then **changed the source file** to "LIVE DRIFT SOURCE v2 — drifted".

The model presented the candidate (evidence scope: 1 exact revision) and
called `approve_proposal(PROP-33c9cdef…, 1, sha256:6f546ff8…)`. The real
permission dialog was Allowed. The commit-time gate **denied** — verbatim tool
result on screen:

```json
{"ok":false,"code":"FINALIZATION_DENIED","message":"the FinalizationGate denied finalization for 1 reason(s)"}
```

Verified in the store after the denial: **no Approval beyond the fixture
design commits, no new PlanCommit, no FinalPlan** (count 0), the final
proposal **still awaiting_approval**, HEAD unchanged (`CMT-4baf5694…`), run
stage/revision unchanged (final/14), and — §49/§11 — the discovered drift
**persisted** as a real system fact:
`evidence_validation_events: SOURCE_CHANGED / revalidation_check_changed` on
`ev_2fff221f@1`. No commit-time audit row exists (the write never happened).

Operator note: the harness shows the MCP error envelope's `code` + `message`
to the model; the structured `reasons[]` ride in the error `detail`
(visible to log inspection, e.g. `EVIDENCE_CRITICAL_NOT_FRESH` on
`ev_2fff221f@1`). The automated suites assert the reason payloads directly.

## E78 — Phase 8–12 live semantics remain compatible

The shared store still carries every prior live run untouched (Phase 11
legacy synthesis run, Phase 12 run at synthesis) and the live Phase 12
`/compact` recovery, validator flow, and reopen semantics all re-verified by
the automated suites. Run A/B remain at stage final attached to their
sessions — the exact Phase 14 recovery seam.

No settings/account changes, no nested Claude, no simulated plan-mode
restoration, no debug mutation tools (fixtures used the domain's own prepare/
synthesis/finalization services under the `PHASE_PLAN_LIVE_STORE` seam).
No secrets, tokens, or private transcript content recorded here.
