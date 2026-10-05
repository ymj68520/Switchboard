# Canonical E14 Exit Ledger (Phase Plan v0.2.0)

Provenance: recovered verbatim on 2026-10-05 from the original E14 exit-gate
directive ("Phase Plan v0.2.0 — E14, Full End-to-End Exit Gate Matrix +
Release Closure", §51 "E14 Exit Invariants"), preserved byte-identically in
two workspace attachments dated 2026-10-02 17:02
(`pasted-text-20261002-170246-a2dc14f2.txt` and its byte-identical twin
`pasted-text-20261002-170301-dffd43f3.txt`). The wording below is frozen
exactly as authored; it is NOT a reconstruction. Two rows carry formal
supersession notes from already-approved governance actions (I31 — the A1-II
closure correction; I35/I39/I40 — the frozen A1 amendment and the
adjudicated baseline shrink); the frozen wording itself is never altered.

```text
E14-I1
The complete planning → execution → completed path works through real authority boundaries.

E14-I2
PlanningRun/ExecutionRun handoff remains exactly-once and recoverable.

E14-I3
FinalPlan remains the sole normative execution authority.

E14-I4
Multiple implementation Directives can share one Window.

E14-I5
candidateRevision deterministically stales prior verification.

E14-I6
Ordinary verifier defect causes rework without forced replanning.

E14-I7
Factual conflict uses at most one bounded resolver.

E14-I8
Blocked Worker revision flow never performs mid-attempt semantic mutation.

E14-I9
Executor scope adaptation is guidance-based, not path hard-enforcement.

E14-I10
Missing normative design can terminate in replan_required.

E14-I11
Replan transition atomically records ExecutionIssue.

E14-I12
Successor planning creates a new PlanningRun.

E14-I13
New/reconfirmed FinalPlan creates a new ExecutionRun, never rebinds old Run.

E14-I14
Report durability prevents replay after lost acknowledgement.

E14-I15
Side-effect interruption becomes indeterminate rather than assumed success/failure.

E14-I16
Indeterminate work is reconciled through new inspection authority.

E14-I17
Recovered candidate mutation advances revision without fabricating original Report.

E14-I18
/clear never silently retains/transfers writable Supervisor authority.

E14-I19
Fork never inherits writable execution ownership.

E14-I20
Compaction and rewind never rewrite Execution Memory.

E14-I21
Explicit takeover increments generation and fences former owners.

E14-I22
Claimed Worker authority survives Supervisor replacement only for its exact Attempt.

E14-I23
Prepared Worker credentials are fenced across takeover.

E14-I24
Human-authorized abort is terminal and distinct from completion/replan.

E14-I25
Abort never rolls back workspace or accepted state.

E14-I26
completed, replan_required, and aborted are mutually exclusive terminal outcomes.

E14-I27
ExecutionCommit remains the only acceptedHead advancement authority.

E14-I28
Candidate revision has only the frozen two mutation authorities.

E14-I29
ExecutionRun final completion requires Final Closure + CompletionGate.

E14-I30
No terminal Run can regain writable execution authority.

E14-I31
Same FinalPlan may create separate later ExecutionRuns.

E14-I32
WorkspaceIdentity prevents transparent worktree migration.

E14-I33
Recovery truth is reconstructed from Store, never conversation history.

E14-I34
Historical Directive v1/v2/v3 hashes remain valid.

E14-I35
All supported migration paths converge on valid schema v25 without fabricated history.

E14-I36
Model-facing tools expose no raw authority bypass.

E14-I37
Frozen v0.2.0 non-goals remain absent.

E14-I38
All E1–E13 frozen invariants remain intact.

E14-I39
The four known Windows baselines are unchanged and no new regression exists.

E14-I40
No architecture amendment is required for release closure.
```

## Supersession notes (governance-recorded; wording above untouched)

- **I31** — the original closure proof attempt (successor-chain replan) is
  SUPERSEDED. Under the accepted A1-II closure correction the canonical
  requirement is: same exact immutable FinalPlan → separate later
  ExecutionRun, through the real human-authorized `reexecute_final_plan`
  production path. Decisive evidence:
  `adapters/claude-code/test/a1ii-e14-i31-integrated.test.ts`.
- **I35** — "schema v25" reflects the pre-A1 authoring baseline; the frozen
  A1 amendment sets the convergence target at schema 26. Evaluated at 26.
- **I39** — the original four Windows baselines were reduced to three by the
  independently adjudicated fixture-canonicalization fix (A1-I closure,
  phase17 4→3 adjudication). Evaluated at three.
- **I40** — on 2026-10-02 this invariant FAILED (E14-I31 was structurally
  impossible under the shipped v14 DDL), which produced the now-frozen
  A1 amendment. Under the A1-III baseline ("A1 = FROZEN") it is evaluated as:
  no amendment BEYOND the frozen A1 / A1-I / A1-II is required for release
  closure.
