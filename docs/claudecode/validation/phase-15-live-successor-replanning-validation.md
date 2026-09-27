# Phase 15 Live Validation — Real Build → ExecutionIssue → Successor Replanning

Date: **2026-09-27** · OS: **Windows 10.0.19044** · Claude Code: **2.1.283** ·
Node: **24.21.0** (hooks/MCP) · Plugin: inline
`--plugin-dir D:\Programing\agent\plan-plugin\adapters\claude-code` on top of
commits `332df97` (feat) + `75fe3d3` (tests) + live-closure fixes
`a237588` and the follow-up fix commit (this document's sibling) · Plan Store
schema **12** · auth: the account's configured API endpoint; no credentials or
tokens are recorded here.

## Host-compatibility deviations (recorded, all session-scoped)

The live run required three host-level accommodations, all applied through the
CLI-scoped `--settings` file (`~\.phase15-live\claude-hooks-settings.json`)
and one PTY driver detail. User `settings.json` stayed byte-identical
throughout (sha256 `def5d0df…b4c` before == after; no workspace settings file
was ever created):

1. `ENABLE_TOOL_SEARCH=false` — with tool search enabled, MCP tools are
   deferred and their calls never reach PreToolUse hooks, so no signed host
   context can be minted (`HOST_CONTEXT_REQUIRED` fail-closed).
2. Session-scoped copy of the plugin hooks — the host's plugin-hooks rollout
   gate was off on a cold GrowthBook cache in the PTY launch, so hooks were
   registered via `--settings` (absolute paths); from the post-resume session
   onward both registrations fired (every hook ran exactly twice: settings +
   plugin).
3. `permissions.allow` for the phase-plan MCP read/planning tools — in plan
   mode each MCP call raised a permission dialog that the PTY driver had to
   answer one by one; `approve_proposal` was deliberately NOT allow-listed so
   its `requiresUserInteraction` dialog stayed mandatory (§24).

The session ran under a real PTY (node-pty/ConPTY) with a control-file driver
so the operator path (typed prompts, slash commands, dialog keystrokes) is the
real TUI. `MSYS_NO_PATHCONV=1` was required in the driver's shell — MSYS path
conversion silently rewrote a leading-slash argument `/phase-plan` into
`D:\Software\Tools\Git\phase-plan`.

## Predecessor world (sanctioned fixture/domain-service seam)

Built by `test/live-fixture.test.ts` mode `phase15` directly inside the
host-managed data root `C:\Users\Administrator\.claude\plugins\data\phase-plan-inline\`
(store already at v12 from an earlier open; all seven v12 tables empty):

- Workspace: `ws_e6677afd…` — **git_worktree** at `C:\Users\Administrator\phase15-live-ws`,
  repository baseline `git @ abca47857e0e6c6f8ecb8d7b4d6687622917889e`
- Run **P** = `plan_3340f6cf-8fbc-4532-a39f-54350f232d23` — completed / final / rev 12
- FinalPlan **FP** = `fplan_c39c9060-8a20-4f64-8e69-4619eb4bfa60` @1,
  `sha256:3800db08f4cd69d43eae7af9705e8a3dc81b8de03fdec5b76073785f16f4f19a`
- HEAD `CMT-7e217662…` / `snap_2380e582…` = ARCH-1@1 + SEC-1@1 (title **SEC-A**) +
  SEC-2@1 (**SEC-B**, depends on SEC-A) + SEC-3@1 (**SEC-C**, independent);
  7 commits / 7 approvals / 4 memory revisions / 0 observations / 0 evidence
- Handoff `xhandoff_31f60992-f2d6-42e6-afcb-1f30018834e9`
  (`sha256:bfc746c1…`) **delivered** at 10:43:54Z; ExecutionBinding attached
  **generation 1**, session `3e3b9af1-51c3-4c00-a874-1b09d8a20271`
- Pre-state dump: `~\.phase15-live\pre-state.json` (v12 tables all zero)

## L15-1 / E70 — real report_execution_issue

The live model read the exact ref via `read_memory`, then called
`report_execution_issue` through the full production chain (ExecutionHostContext
signed by PreToolUse → MCP → store transaction; debug log: "Hook approved tool
use … bypassing permission prompt"):

- Issue **`xissue_54e91d17-04f1-466b-ab5d-347cdf23459d`**, kind `section_contract`
- Affected ref `[{type:"section_contract", id:"SEC-1", revision:1}]` — exact
  FinalPlan closure
- `operation_id` = `execution-issue:call_b28937a4fb584cf5b3153b3e` — derived
  from the SIGNED host toolUseId (§15)
- Server-side git capture: repository `git @ abca4785…` (model-supplied
  fields were only kind/summary/detail/affected_refs)
- `execution_issue_refs` +1; adoptions 0; `openCount 0 → 1`, `replanRequired
  true`

## L15-2 — predecessor immutability after the issue

Pre vs post issue dumps identical: run P row, FinalPlan id/hash, HEAD,
commit/approval/proposal counts, memory revisions, section workflow rows,
observations, evidence, handoff row + delivered state — all unchanged.

## L15-3 — execution mutation guard

Model-invoked `Write PHASE15_SHOULD_NOT_EXIST.txt` was denied by the
PreToolUse:Write hook — verbatim denial:

```
EXECUTION_REPLAN_REQUIRED: an open ExecutionIssue records that the approved
FinalPlan cannot be implemented as-is; repository mutation is paused. Invoke
/phase-plan to start the successor PlanningRun from the immutable baseline (1
open issue(s)).
```

No file was created; a PowerShell probe was denied the same way. No
permission dialog preceded the denial. Reads stayed available (L15-4):
Read/get_state/get_context(detail=build)/read_memory all succeeded with
`openCount: 1`, `replanRequired: true`.

## L15-5 / L15-6 / L15-7 — explicit /phase-plan → successor

The operator typed `/phase-plan` in the real TUI (skill expansion fired; fresh
`phase-plan:entry-v1` token injected — never fabricated):

- `start_or_resume` → **`started_successor`**, one write transaction
- Successor **S** = `plan_59878a29-f949-4351-8fd4-ef08e3d76fce` — active /
  **detail** / rev 1; **P ≠ S**; P never reactivated (still completed/final)
- Old ExecutionBinding detached (+1); successor planning SessionBinding
  **attached, generation 1**, same session + workspace
- Mode transition: PermissionRequest hook answered
  `setMode(plan, destination=session)` — plan mode visibly ON in the same
  Claude session; settings untouched

Adoption: exactly ONE row (`xissue_54e91d17…` → S, position 1). Baseline
`sbase_72286d50-d756-4e71-8833-924f4a1b6b17`
(`sha256:fcde2a48…`): binds exact FP id/hash, final snapshot/commit, handoff
id, issueSetHash `sha256:36a1801e…`, repository `git @ abca4785…`.

## L15-8 — scoped reopen is exact

`planning_run_baseline_scopes`: **SEC-1 needs_review, SEC-2 needs_review,
SEC-3 inherited_completed** (origin run P, origin revisions 1). SEC-C was not
reopened; stage stayed `detail` — the DAG closure (SEC-B depends on SEC-A)
derived server-side from the committed section contents.

## L15-9 — baseline-before-HEAD

Immediately after creation: successor HEAD **absent**, PlanCommits 0,
Approvals 0, Proposals 0, local memory revisions 0, materialization row
absent — while baseline + scopes + adoption existed. No fabricated
authorization.

## L15-10 — baseline reads

`read_memory` for SEC-1@1, SEC-3@1 and ARCH-1@1 each returned
**`authority: "successor_baseline"`**, refs resolving against the
predecessor's immutable Plan Memory (recorded live by the model and in the
transcript). `get_context` exposes the successorBaseline block; `get_state`
showed the successor view. (The negative probe SEC-A@N-1 was not repeated
live — the fixture sections only have revision 1; the rejection is pinned by
the automated suite.)

## L15-14a — pre-materialization compaction

Real `/compact` with successor alive, baseline present, HEAD absent,
`materialized=false`. The SessionStart:compact capsule carried the successor
segment (recovered via the resume capsule of the same build, byte-equal
segment): successor run, predecessor FinalPlan, adopted issue,
needs_review=[SEC-1, SEC-2], inherited=[SEC-3], **"Baseline materialized:
no"**. This compact surfaced a real bug — see "Live bugfixes" below.

## L15-11 — successor-run observation

`Read source_module.py` in plan mode produced observation
`obs_f50d8315…` with **run_id = S** (seq 1). Predecessor observation/evidence
counts unchanged (0/0).

## L15-12 / §23 — first V4 proposal binds the exact baseline

`prepare_proposal` (section-scoped) froze `PROP-eb771d66-de7a-4f36-be57-30558713195e@1`
— canonical **version 4** with `successorBaseline` exactly equal to the
baseline row (baselineId/baselineHash/finalPlanId/finalPlanHash/issueSetHash).
At that moment: approvals 0, commits 0, HEAD absent, local memory revisions 0,
materialization absent — `prepare_proposal` did not materialize anything.

## L15-13 — real human Approval → first successor PlanCommit

The model called `approve_proposal(PROP-eb771d66@2, sha256:fb66363e…)`. The
**real requiresUserInteraction dialog** appeared (PreToolUse `ask`:
"approve_proposal requires explicit user approval") and the operator pressed
**Yes**. One authorized transaction then:

- Approval `APPR-cf1529db…` with `authorization_request_id =
  mcp-approve:call_59bdd52749a14b2b83587543` — derived from the signed
  toolUseId of that dialog-approved call (§29: exactly one approval, the real
  one; no synthetic authorization anywhere in the run)
- PlanCommit `CMT-f5d30807…` (seq 1) → snapshot `snap_61d0282e…` → successor
  HEAD advanced exactly once
- Baseline materialization record inserted for `sbase_72286d50…` bound to
  exactly this commit/snapshot — **only now**

## §26 — materialization identity

All four carried revisions — ARCH-1@1, SEC-1@1, SEC-2@1, SEC-3@1 — are
**byte-identical** with the predecessor's memory revisions (content_json,
compact_projection, contract_json, created_at). SEC-1 additionally carries
the successor-approved revision 2 (objective "SEC-A objective -
phase15-live-replanned") — the actual ExecutionIssue → design-change proof.

## §27/§28 — predecessor untouched; no fabricated completion

After the commit, run P remained completed/final/12 with its original HEAD,
FinalPlan hash, 7 commits, 4 memory revisions and completed workflow rows.
SEC-1/SEC-2 hold honest successor-local **open** workflow rows; SEC-3 has no
local workflow row and satisfies workflow through `inherited_completed` — no
fake COMPLETED event, no fake proposal/approval/commit for it.

## §30 — post-materialization compaction

A second real `/compact`: the SessionStart:compact capsule now shows
"Baseline materialized: **yes**", successor HEAD = `CMT-f5d30807…` /
`snap_61d0282e…` (exact), predecessor lineage unchanged.

## Live bugfixes (found by this closure, fixed, regression-pinned)

1. **Restart-recovery shadowing** (`a237588` + this fix commit): a host
   restart re-attached the delivered ExecutionBinding (phase-14 E87 recovery)
   and detached the successor planning binding, so `/phase-plan` re-entry hit
   `SUCCESSOR_RUN_ALREADY_STARTED` forever. Fix: start_or_resume now lets the
   planning resume (Case A/B) win when the session owns planning life;
   regression tests pin both the attached and detached variants.
2. **Schema validation vs baseline-before-HEAD**: the v8 checks "active
   section ∈ HEAD snapshot" and "every section identity has a workflow row"
   contradicted §16 (no HEAD before the first authorized commit) and §28
   (inherited_completed sections stay row-less). First symptom: every hook
   process failed `STORE_SCHEMA_INVALID` after `select_section`, so the
   compact capsule silently degraded. Fix: both checks carry a v12-gated
   exemption for needs_review / inherited_completed scopes of the successor
   baseline; regression test re-opens the store over the exact live sequence
   and still rejects an out-of-scope orphan.
3. **Prepare-time coherence**: `prepare_proposal` accepted a
   section_completion without COMPLETE_SECTION while approve_proposal
   rejected it at commit time. Fix: the prepare-time workflow gate mirrors
   the rule (incoherent input now dies before freezing).

## §35 — final automated regression

Node 24.21.0: typecheck 0, eslint 0, build OK, **884 passed | 1 skipped**
(881 baseline + 3 live-closure regression tests). Node 22.23.2: full suite
green. OpenCode adapter: **634 passed** (independent line, untouched).

## §8/§111 — hygiene

User `settings.json` sha256 identical before/after. No secrets, tokens,
HostContext signatures, or private transcript content in this document. The
recovery capsule and contracts contain no signature/session/plugin-path
material (re-verified in the quoted blocks above).
