# Phase 10 Live-Host Validation — Real Evidence Freshness Gates (§67–§70)

Status: **PASS** — the changed-source gate blocked a REAL user-authorized
approval before PlanCommit, and the revalidation → revised-proposal → commit
closure succeeded, all against a real, authenticated interactive Claude Code
host. No settings workarounds, no debug mutation tools.

Host: Claude Code **2.1.282**, Windows 10.0.19044, Node **24.21.0** first on
PATH, auth `oauth_token`. Plugin: inline
`--plugin-dir D:\Programing\agent\plan-plugin\adapters\claude-code` (dist built
from commit `104570e`). Workspace:
`C:\Users\Administrator\phase10-live-ws` (fresh registration; fixture file
`phase10-gate.txt` = `PHASE10 GATE SOURCE v1\n`, 23 bytes).
Store: the host-managed inline-plugin root
`C:\Users\Administrator\.claude\plugins\data\phase-plan-inline\` (shared with
Phase 7–9 live runs — see §1). Debug evidence: `debug.log`, `debug2.log`,
`debug3.log` in the workspace (the first two log the launches described in §5).

Session: interactive TUI, run
`plan_c734471a-dcd4-40fe-96ab-cb3999071497` (goal “Phase 10 evidence
freshness live validation”), plan mode on via the normal `/phase-plan` →
`setMode(plan, destination=session)` chain.

## 1. Live migration 6→7 on the real store

The shared host store was at `user_version` 6 when the Phase 10 binary first
loaded; the plugin's own migration path advanced it to **7** with history rows
`1..7` ending `evidence-freshness-foundation`, and the host store's
pre-existing Evidence (from Phase 9 live runs in other workspaces) is now
materialized `needs_validation` — the §9 fail-closed initialization applied to
REAL data.

## 2. MCP surface

Server banner: `mcp server 'phase-plan' v0.1.0 ready on stdio (8 tools)` —
`revalidate_evidence` present (§50).

## 3. §68 — changed-source gate blocks an authorized proposal

1. **Read → Observation**: the model read `phase10-gate.txt`; PostToolUse
   captured observation `obs_e7150990-5ca0-4038-9d9e-66b2adb04e22` (seq 2,
   source, whole-file fingerprint `sha256:542d807e…b228`, size 23).
2. **Promote**: the model called `promote_evidence` (critical `source_fact`,
   claim “gate source declares v1”, observation_refs=[that id]) →
   `ev_2b80e1d6-06ab-425f-a46c-de3dd06b414e@1`, and the model's own on-screen
   report quoted the §10 initialization: “Freshness: fresh — reason
   `promotion_fingerprint_match` (strategy fingerprint…)”. Store:
   `evidence_current_states = fresh`, event `INITIALIZED → fresh`.
3. **Frozen Proposal V2**: prepared through the sanctioned live-fixture seam
   (`test/live-fixture.test.ts`, mode `phase10`; the same TEST-ONLY seam the
   Phase 7/8 live validations used — prepare has no MCP surface by design):
   `PROP-dca096f9-7f5c-4e38-8e81-eea2ad227aed@1`, hash
   `sha256:8a7fd8e1…995a`, `requiredEvidence=[ev_2b80e1d6…@1]` (relational
   index verified equal to the canonical content).
4. **External source change** (operator, outside the host): the file became
   `PHASE10 GATE SOURCE v2 CHANGED AFTER APPROVAL`.
5. **REAL user approval**: the model called `approve_proposal` with the exact
   triple; the host showed the real `requiresUserInteraction` dialog and the
   user selected **Yes**. The commit-time gate re-hashed the source, found the
   mismatch, and the tool FAILED:
   `{"ok":false,"code":"EVIDENCE_NEEDS_VALIDATION","message":"critical required Evidence is not fresh for 1 ref(s); revalidate and freeze a new Proposal revision"}`.
6. **Post-failure invariants (§37/§38/§64/§65/E29/E30)**: approvals for this
   run = 0; plan_commits = 0; HEAD unchanged (this run had none); proposal
   state still `awaiting_approval`; AND the system fact persisted:
   `evidence_validation_events` gained
   `SOURCE_CHANGED → needs_validation (revalidation_check_changed)` — durable
   proof of §37's independent-fact rule.

## 4. §69 — revalidation closure and successful re-commit

1. **Re-read**: the model read the changed file → new observation
   `obs_ea890b92-cae2-4b7c-a86b-956e4ead7049` (seq 6).
2. **Revalidate (live MCP)**: `revalidate_evidence` mode=assess,
   assessment=confirmed, observation_refs=[the new id] — completed in 32 ms.
   The model printed the exact §51 envelope:
   `{"ok":true,"status":"confirmed","idempotent":false,"target":{"evidence_id":"ev_2b80e1d6…","revision":1,"previous_state":"needs_validation","current_state":"stale"},"replacement":{"evidence_id":"ev_2b80e1d6…","revision":2,"state":"fresh"},"reason":"revalidation_confirmed_replacement"}`.
   Store: `@1 stale`, `@2 fresh`; events `INITIALIZED@2 → fresh` +
   `REPLACED@1 → stale`; one additional `EVIDENCE_PROMOTED` audit row for the
   replacement write.
3. **Revise (fixture seam, mode `phase10-revise`)**: the awaiting proposal was
   superseded by `PROP-dca096f9…@2`, new hash
   `sha256:b7310e01…9ca7`, `requiredEvidence=[ev_2b80e1d6…@2]` — the frozen @1
   was never rewritten (§43/§72).
4. **REAL user approval again**: `approve_proposal` @2 with the new hash;
   the user selected **Yes**; the tool completed successfully in 44 ms. The
   model's verbatim on-screen result:
   `{"ok":true,"approved":true,"approval_id":"APPR-80346aca-4bbd-4d27-a822-30010358940f","commit_id":"CMT-7942f152-d646-4149-8ac6-a557099178f8","snapshot_id":"snap_fe04c2e3-bbfb-4f09-a0a4-ad2c9cc3797f","idempotent":false,"new_run_revision":2,"new_stage":"architecture"}`.
5. **Closure invariants**: EXACTLY ONE approval (`APPR-80346aca…`,
   proposal_revision 2), EXACTLY ONE PlanCommit (`CMT-7942f152…`, sequence 1),
   HEAD moved once to `snap_fe04c2e3…/CMT-7942f152…`; proposal states
   `@1 superseded, @2 approved`; audit for the run:
   `EVIDENCE_PROMOTED ×2, PROPOSAL_PREPARED ×1, PROPOSAL_REVISED ×1,
   PLAN_COMMITTED ×1`.
6. `/exit` → `SessionEnd:prompt_input_exit … status 0`, binding detached.

## 5. FileChanged probe (§67/§18/§19)

Headless probe runs (`-p` + probe plugin registering `FileChanged`,
`FileChange`, `WatchFiles`, plus PostToolUse/SessionStart controls):
`FileChange`/`WatchFiles` are rejected by the host validator as unknown hook
events; `FileChanged` is an ACCEPTED event name but **never fired** on two
real Write-tool edits (controls fired both times). Validation record:
*FileChanged unavailable on the tested host; correctness covered by gate-time
fingerprint validation* — exactly as §18 anticipated, so no substitute hook or
second source-change oracle was built. The FILE_CHANGED_HINT transition
semantics are pinned by unit tests instead.

Two interim TUI launches also documented a Node-version counter-test: with
Node 22.23.2 first on PATH the MCP child refused to start
(`UNSUPPORTED_NODE_VERSION … fail-closed`) and the session surfaced the
host's ~15-minute MCP connect-backoff cache (`~/.claude/mcp-needs-auth-cache.json`);
both are host behaviors, resolved by relaunching with Node 24 and clearing the
cache file.

## 6. Prohibitions honored

No settings.json modification, no defaultMode, no debug mutation tools, no
capability-proofs editing; every permission — including BOTH approve_proposal
interaction dialogs — was granted through the real host dialogs (number-key
selection verified via debug.log, not screenshots). Host-context tokens and
prompt transcripts are never reproduced here.

## Result

| Gate (§68–§70) | Result |
| --- | --- |
| live migration 6→7 incl. §9 needs_validation backfill on real data | PASS |
| 8-tool MCP surface | PASS |
| Read → Observation → promote critical fingerprint EV@1 (fresh) | PASS |
| ProposalCanonicalV2 frozen with exact requiredEvidence | PASS |
| external source change; REAL user Allow → `EVIDENCE_NEEDS_VALIDATION` blocks | PASS |
| no Approval / no PlanCommit / HEAD unchanged / proposal still awaiting | PASS |
| SOURCE_CHANGED system fact persisted independently (§37) | PASS |
| revalidate confirmed → EV@1 stale, EV@2 fresh (§51 envelope on screen) | PASS |
| revised proposal @2 + new hash requiring EV@2 (no rewrite of @1) | PASS |
| REAL user Allow → exactly one Approval, one PlanCommit, HEAD moved once | PASS |
| FileChanged probe: recognized, never fires; correctness via gate-time validation | PASS (documented) |
