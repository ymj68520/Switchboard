# Phase 17 — v0.1 Golden E2E Validation Record

Directive: Phase 17 §3–§11 (golden path, no fixture stage jumps), record per §49.
Host: Claude Code 2.1.283, Windows, Node 24.21.0 first on PATH, the committed plugin
(inline `--plugin-dir`), fresh debug logs, PTY-driven real TUI (control-file harness).

## Run identity

- **Golden run G2**: `plan_fa7e18c2-d1e7-4ef4-aa01-17b573c80c01` — lifecycle
  **completed**, stage final, final revision 22, workspace
  `C:\Users\Administrator\phase17-golden-ws` (fresh; repo `url-sentinel`:
  README.md + src/health.ts + src/config.ts, git).
- Session: `c1d7a2e4-5b93-4f60-8a21-9e3d47c60b12` (one session across the whole
  lifecycle, including two hard-kill/resume cycles).

## Golden chain (all steps real, no fixture jumps)

| Step | Result |
| --- | --- |
| /phase-plan entry (EntryIntent + start_or_resume + setMode(plan)) | ✅ run created at discovery |
| Discovery: real repository observation | ✅ Read/README + src/health.ts observations captured via natural PostToolUse |
| Evidence promotion | ✅ 2 critical fingerprint-backed (src/health.ts, src/config.ts) |
| Architecture proposal → real human Approval (mandatory dialog Yes) | ✅ PROP @1, one Approval + one Architecture PlanCommit |
| Architecture completion → real Approval | ✅ stage → detail |
| Section DAG (dynamic) | ✅ SEC-1 "Probe engine" + SEC-2 "HTTP report server" (dependency edge SEC-2→SEC-1) |
| **Compaction #1 (during Detail)** | ✅ /compact; state rebuilt from Store (binding attached gen 1 unchanged, detail/rev 3) |
| SEC-1 completion → real Approval | ✅ completed |
| **Evidence invalidation (§5)** | ✅ operator committed `e423259` (timeout 2000→…); revalidate_evidence → `SOURCE_CHANGED`, state needs_validation → **SEC-1 needs_review** (exact dependent propagation, SEC-2 untouched) |
| Invalidation recovery | ✅ re-observe → successor critical evidence promoted (new id, fingerprint-fresh) → new SEC-1 completion (atomic §40 composition) → real Approval → completed (completed_revision advanced) |
| SEC-2 completion → real Approval | ✅ both completed → **synthesis** (SynthesisInput auto-created at detail completion) |
| SynthesisManifest | ✅ submit_synthesis (cross-section links, implementation order, limitations) |
| **Real isolated validator** | ✅ phase-plan validator subagent called submit_validation with V2 agent attestation — **report 1: NOT clean** — the validator caught a real semantic divergence (manifest said the SEC-2 store exposes `snapshot()` while DEC-3/ARCH-1 mandate `report()`) |
| Validator-finding recovery (frozen §52 path) | ✅ request_reopen (scoped) → both sections needs_review → re-completions with the DEC-3-aligned API (record(entry) upsert + report() accessor) → corrected manifest → **report 2: clean (is_clean = 1)** |
| **Compaction #2 (during Validation)** | ✅ /compact; authoritative state preserved |
| request_finalization → Final Plan Candidate | ✅ deterministic candidate frozen |
| **Real human Final Approval** (mandatory dialog Yes) | ✅ one Final Approval + Final PlanCommit + **FinalPlan `fplan_7ed47679-a5ad-4d36-900b-331ab6d41035`** immutable |
| handoff → natural host delivery | ✅ PermissionRequest mode transition → MCP handler → **host PostToolUse → production delivery finalizer → DELIVERED exactly once** — run **completed** (rev 22) |
| §11 final invariants | ✅ Planning SessionBinding detached (gen 2); **ExecutionBinding attached (gen 1)**; HEAD = final PlanCommit snapshot |
| Same-session Build read-side | ✅ get_state under EXECUTION authority returns the completed run + contract |
| Planning mutation denied in Build | ✅ prepare_proposal refused `STALE_SESSION_BINDING` at the PreToolUse gate (typed, zero mutation) |
| Harmless execution smoke | ✅ ordinary host work: `smoke/build-smoke.txt` created (`phase17 build smoke ok`) |

Real human Approvals in G2: **10** (architecture, architecture completion, section
DAG, SEC-1, SEC-2, invalidation-recovery SEC-1, SEC-2 reopen recovery, final
proposal, plus prepare-flow dialogs), every one through the mandatory
requiresUserInteraction dialog — never auto-allowed.

## Divergence record (G1, preserved honestly)

The first golden attempt `plan_ada8e538-6b6b-4b65-bb95-4d014e21cc0f` reached
detail (10 real approvals, invalidation cascade + successor recovery proven) and
then diverged: the SEC-4 completion proposal awaited with required evidence that
the invalidation had made stale, and approval kept failing
`EVIDENCE_NEEDS_VALIDATION`. Root cause chain, all captured live:

1. The frozen recovery ("revalidate and freeze a new Proposal revision") was
   unreachable — `reviseProposal` had no MCP surface → **fixed** (`6ba0b56`,
   optional `proposal_id` on prepare_proposal with §83 replay).
2. Claude Code 2.1.283 snapshots plugin MCP tool schemas keyed on server
   identity+version → rebuilt bundles never reach sessions → **fixed**
   (`86ab73f`, RUNTIME_VERSION 0.1.1).
3. The model gateway's JSON escaping appends a stray trailing backslash to long
   copied identifier values → **fixed** (`90d510b`, identity-field trim after
   signed-context verification).
4. The gateway/model combination still could not reliably drive the revise flow
   in-session; G1 was terminated by a human-authorized abort_run (real mandatory
   dialog) — terminal, never reattached — and G2 ran clean end-to-end.

The engine gate's transitive evidence closure (committed decisions carrying
invalidated evidence revisions block downstream approvals until the pinned
revision is fresh again — here restored by reverting the drill edit, content +
git revision byte-match) is documented as a recovery finding in the matrix
record.

## Verdict

**E1–E13 PASS** on G2: one fresh real-host run traversed /phase-plan → completed
Build without fixture stage jumps, with real observation, evidence promotion and
invalidation, real human approvals, dynamic section DAG, real isolated validator
(including a genuine finding + frozen recovery), two real compactions,
deterministic finalization, natural-host handoff delivery, same-session Build
read-side with mutation denial and a harmless execution smoke.
