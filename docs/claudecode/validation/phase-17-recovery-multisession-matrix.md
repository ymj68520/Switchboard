# Phase 17 — Recovery / Multi-Session Matrix Record

Directive §12–§35 (recovery matrix A–J, multi-session A–H, classification seam),
record per §50. Each row: scenario, interruption, recovery action, expected vs
observed authority, result. Automated rows are pinned in
`test/phase17-recovery-multisession.test.ts`, `test/phase17-system-matrix.test.ts`
and `test/phase17-capability-matrix.test.ts` (commit `04b5848`); live rows were
executed on Claude Code 2.1.283 during the golden session(s).

## Recovery matrix

| Row | Scenario | Interruption | Recovery | Expected authority | Observed | Result |
| --- | --- | --- | --- | --- | --- | --- |
| A (§12) | active planning crash (Discovery; Detail+active section) | hard process kill, NO SessionEnd | `claude --resume <exact session>` | same run, binding untouched/reattached, HEAD unchanged, A1 when mode lost | live: run `plan_11d047ae…` active/discovery, binding attached gen 1 (never bumped), Recovery Capsule `[Phase Plan Recovery v4]` rebuilt from Store injected; automated: same-run/gen/HEAD pins + A1 context | **PASS** |
| B (§13) | crash with an awaiting Proposal | hard kill after prepare | exact-session resume | same proposal id/revision/hash; then exactly one Approval + one commit | live: G1 awaiting `PROP-46176351…@1` survived the kill/resume byte-exact; automated: id/rev/hash preservation + single approval/commit | **PASS** |
| C (§14) | crash after Approval/commit BEFORE the response | sanctioned same-invocation retry | retry the same signed invocation | idempotent=true, same Approval/Commit/Snapshot, never a second commit | automated (`mcp-phase7` + matrix): same commit_id/approval_id, counts stay 1 | **PASS** |
| D (§15) | Final Approval crash before response | same seam | same-invocation retry | same FinalPlan/Approval/Commit/HEAD | automated (`request-finalization`, `final-authorization` + matrix): idempotent replay, one FinalPlan | **PASS** |
| E (§16) | handoff crash window A (mode transitioned, handler failed before PREPARED) | crash | retry WITHOUT restoring Plan Mode (§89) | same FinalPlan, retry allowed, natural delivery completes | automated (`execution-handoff` window A) + matrix row: prepared → delivered → completed | **PASS** |
| F (§17) | handoff crash window B (PREPARED + binding, finalizer lost) | crash | retry reuses SAME handoff id/hash | run still active/final, Build blocked, one DELIVERED, one completion | automated window B + matrix: same handoff_id/hash, Build deny, single delivered state | **PASS** |
| G (§18) | completed Build crash/resume | SessionEnd + resume | exact-session resume | ExecutionBinding generation advances exactly once per detach/reattach, Execution Contract restored | automated + live (golden session resume cycles): gen N → N+1 → N+2, contract text injected | **PASS** |
| H (§19) | successor before materialization | crash/resume | exact-session resume | same successor run, HEAD absent, same issue set, no synthetic HEAD | automated (`execution-issue-successor` §73 rows + matrix): HEAD still null, adoptions unchanged | **PASS** |
| I (§20) | successor after first PlanCommit | crash/resume | resume | same successor HEAD/lineage/materialization; predecessor immutable | automated (§46–§53 rows): materialization⟧HEAD coherence + predecessor immutability pins | **PASS** |
| J (§21) | abort recovery | human-authorized abort, then crash/resume/compact/startup | resume attempts | never reattached; no persisted mode-warning state; A2 notice host-runtime only | **live**: G1 aborted at detail/rev 21 via real dialog (`abort:call_0240a39ff3aa4a3db5f5e170`, binding detached gen 8); SessionStart resume/compact/startup never reattached (automated pins) and no mode-named column exists anywhere | **PASS** |

## Multi-session matrix

| Row | Scenario | Expected | Observed | Result |
| --- | --- | --- | --- | --- |
| A (§22) | two sessions, two independent runs, one workspace | no repo-wide lock, independent bindings/proposals/HEADs | live: golden + matrix + probe runs coexisted in the store simultaneously (three workspaces + shared store); automated Case E + matrix pins: independent runs, independent bindings | **PASS** |
| B (§23) | explicit takeover integration | G→G+1, same run, old owner fenced | automated matrix B/C: taken_over with generation+1, old owner STALE_SESSION_BINDING (also live in G1 golden-adjacent flows) | **PASS** |
| C (§24) | old owner races mutation | only current generation writes, never dual authority | automated serialized winner-then-fenced (BEGIN IMMEDIATE) + matrix C pin | **PASS** |
| D (§25) | /clear | no writable authority inherited; old run detached/active; fresh /phase-plan required | automated matrix D: SessionEnd(clear) detaches, new identity inherits nothing, only exact-session resume reattaches | **PASS** |
| E (§26) | fork | conversation may exist, bindings NOT inherited | automated matrix E (SessionStart source=fork on a new session id → empty) — the real-TUI fork execution was exercised in the G1/G2 resumes (fork/clear/startup sources); host fork UX recorded as session-scoped | **PASS** (automated; TUI fork recorded) |
| F (§27) | Build /clear | new session cannot read Execution Context / FinalPlan via execution authority; binding not transferred | automated matrix F: clear/fork/startup → no reattach, execution reads fail closed HOST_CONTEXT_REQUIRED; exact resume is the only recovery | **PASS** |
| G (§28) | Build fork | ExecutionBinding not inherited | same row as F (fork source covered) | **PASS** |
| H (§29) | successor ownership under /clear, fork, takeover, exact resume | ordinary planning-binding semantics; lineage grants no bypass | automated matrix H: clear→detach, fork→nothing, takeover→gen+1 (normal fence), exact resume→reattach for the NEW owner | **PASS** |

## Classification seam (§34/§35) and MCP/hooks (§32/§33)

- A1 drift (active + non-plan → DRIFT_GUARD block; entry passes), Phase-14
  handoff-pending (notice, NOT A1), A2 aborted+plan (silent), completed-Build
  (execution authority answers, never A1): pinned in
  `test/phase17-system-matrix.test.ts` (E34–E36) — no misclassification.
- **§32 MCP restart (live)**: the MCP child was hard-killed mid-session during
  G1 (active run, awaiting proposal). The host marked the server failed, every
  tool call answered "MCP server is disconnected", the session itself survived,
  and the operator reconnect (TUI /mcp → Reconnect) restored a FRESH server
  process: the next mutating call received a fresh signed HostContext for the
  SAME SessionBinding and succeeded. The startup environment was never
  authority; no misbinding occurred.
- **§33 hook independence (structural + live)**: hooks are separate processes
  over the canonical Store — SessionEnd/PreToolUse/SessionStart kept working
  (and failing closed) through the entire §32 outage; correctness-relevant hooks
  never require MCP connectivity.

## Schema fencing (§30/§31) and integrity (§41/§42)

- §30: a worker below the on-disk version fails closed STORE_SCHEMA_TOO_NEW,
  zero writes (automated, store + process level).
- §31: genuine v12-on-disk store (sanctioned rewind) → new process migrates
  12→13 → the old floor-12 writer is fenced STORE_SCHEMA_TOO_NEW at the write
  seam with zero writes (Phase 17 automated addition; the fence itself was
  pinned per-version since Phase 3).
- §41: the new bounded `auditStoreConsistency` ran against the LIVE production
  store at phase end: **ok = true, all 11 checks** (integrity, FK, immutable
  triggers, commit chain, HEAD pairs, planning/execution binding uniqueness,
  run-control lineage, handoff provenance, baseline⟧materialization coherence).
  Tamper detection (dropped trigger) pinned by test.
- §42: `auditObservationBlobs` sampled **40 of 145** live observation blobs:
  0 failures (hash path == content hash); corrupt/missing fail closed
  (blob-store pins).

## Workspace identity (§40)

Same repo different worktree → different workspace ids; takeover across
worktrees refused (WORKSPACE_MISMATCH); history durable after workspace loss —
automated (Phase 17 matrix + existing workspace tests).
