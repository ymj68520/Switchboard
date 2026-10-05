# Phase Plan v0.2.0 — Architecture Amendment A1
# ExecutionRun Identity Independence + Same-FinalPlan Reexecution

**Status:** Proposed architecture amendment — pending review and freeze (§57/§58)
**Amends:** `claude-code-phase-plan-v0.2.0-architecture-spec.md` (frozen baseline; unchanged by this file)
**Trigger:** E14-I31 FAIL — E14 Closure Amendment report, 2026-10-02 (`E14 NOT CLOSED` / `ARCHITECTURE AMENDMENT REQUIRED`)
**Schema baseline:** 25 (migration 026 authorized only after this amendment is reviewed and frozen, §40)
**Baseline state:** E1–E13 FORMALLY PASSED / FROZEN; E14 NOT CLOSED
**Date:** 2026-10-03
**Revised:** 2026-10-03 — A1 Closure Amendment: typed run-control targets, ExecutionBinding authority demotion, workspace execution serialization, Directive v3→v4 bridge; invariants extended to A1-I1..I40 (see Revision History)

---

## 0. Amendment Status

Authoritative baseline:

```text
docs/SPEC/claude-code-phase-plan-v0.2.0-architecture-spec.md
```

Implementation baseline:

```text
E1–E13 = FORMALLY PASSED / FROZEN
E14     = NOT CLOSED

schema version = 25
```

Trigger:

```text
E14-I31 failed.

Frozen requirement:
    one exact immutable FinalPlan
        → 0..N independent ExecutionRuns

Current physical implementation:
    one PlanningRun
        → at most one ExecutionRun

Therefore the frozen semantic architecture
cannot currently be represented.
```

This amendment does NOT change the intended v0.2.0 cardinality.

It corrects the implementation architecture so that the already-frozen cardinality is representable.

---

# 1. Frozen Semantic Requirement Remains Unchanged

The authoritative relationship remains:

```text
PlanningRun
    ↓
FinalPlan
    ↓
0..N ExecutionRuns
```

Normal first execution:

```text
PlanningRun P
    ↓
FinalPlan F
    ↓
ExecutionRun E1
```

A genuine later reexecution may be:

```text
PlanningRun P
    ↓
same exact FinalPlan F
    ├─→ ExecutionRun E1
    └─→ ExecutionRun E2
```

Required:

```text
E1.id != E2.id

E1.finalPlanRef == E2.finalPlanRef

E1 never becomes E2

E1 is never rebound

PlanningRun P is never reopened
```

---

# 2. Root Cause

Current storage conflates two identities:

```text
PlanningRunID
ExecutionRunID
```

through `execution_runs.run_id`.

The resulting physical model effectively behaves as:

```text
execution_runs
PRIMARY KEY(planning_run_id)
```

rather than:

```text
execution_runs
PRIMARY KEY(execution_run_id)
```

Execution child objects then inherit the same conflation.

This makes:

```text
same PlanningRun
same FinalPlan
second independent ExecutionRun
```

structurally impossible.

---

# 3. Identity Model — Amendment

From A1 onward the identities are formally distinct.

## PlanningRun identity

```text
PlanningRunID
```

identifies the planning lifecycle that produced approved Plan Memory and the FinalPlan.

## ExecutionRun identity

```text
ExecutionRunID
```

identifies one independent supervised execution instance.

These IDs are never interchangeable.

---

# 4. Canonical ExecutionRun Model

Freeze the conceptual model as:

```ts
interface ExecutionRun {
  id: ExecutionRunID

  sourcePlanningRunId: PlanningRunID

  workspaceIdentity: WorkspaceIdentity

  finalPlan: ExactFinalPlanRef

  lifecycle:
    | "prepared"
    | "active"
    | "completed"
    | "replan_required"
    | "aborted"

  planningBaseline: PlanningSnapshotRef

  executionStartBaseline: RepositoryStateRef

  acceptedHead?: ExecutionCommitRef

  revision: number

  createdAt: Timestamp
}
```

Important:

```text
sourcePlanningRunId is REQUIRED provenance.

It is NOT ExecutionRun identity.
```

Do not make it nullable merely to support reexecution.

Every FinalPlan originates from a PlanningRun, so every ExecutionRun may retain that exact source PlanningRun provenance.

---

# 5. Exact FinalPlan Reference

ExecutionRun binds:

```text
ExactFinalPlanRef
```

which must identify the same immutable approved FinalPlan across independent executions.

At minimum the binding must prove the exact existing:

```text
sourcePlanningRunId
finalPlanId
FinalPlan revision/version
FinalPlan hash where persisted
approval / Final PlanCommit provenance
```

No FinalPlan copy is created for reexecution.

No new FinalPlan revision is created.

---

# 6. Canonical Execution Scope Key

After A1:

> `ExecutionRunID` is the canonical scope key for all Execution Memory.

That includes conceptually:

```text
SupervisorBinding

ExecutionStage

VerificationWindow

ExecutionDirective

ExecutionAttempt

WorkerInvocationBinding

ExecutionReport

SupervisorAssessment

ExecutionCommit

VerificationConflict

AttemptReconciliation

ExecutionIssue

ExecutionAbort

execution-run events

run-control operations targeting execution
```

PlanningRunID must not be used to distinguish execution worlds.

---

# 7. Legacy `run_id`

Current implementation uses ambiguous `run_id` extensively.

After A1:

```text
run_id
```

must never remain an ambiguous new authority concept.

Implementation may temporarily retain a legacy `run_id` storage field when required for:

```text
migration compatibility
historical canonical hashes
legacy audit provenance
```

but:

```text
legacy run_id
≠ canonical ExecutionRun identity
```

All new authority checks, joins, uniqueness constraints, and execution-scoped mutations must use exact `ExecutionRunID`.

## Legacy FK domains (Final Closure Amendment, Problem 3)

After the re-key, `execution_runs.run_id` is no longer unique. Therefore NO post-A1 foreign key may use:

```text
FK(child.run_id) → execution_runs(run_id)
```

as execution ownership — this must hold explicitly across the rebuilt schema.

Where a legacy `run_id` field is retained, it means source PlanningRunID provenance, never ExecutionRun identity. Its FK domain, where an FK remains appropriate, is:

```text
planning_runs(run_id)
```

and/or the exact existing composite planning-owned FinalPlan FK. Never `execution_runs(run_id)`.

Class separation:

- **Class-1 tables** (canonical historical content embeds the legacy id: at minimum `execution_directives`, `execution_issues`, `execution_handoffs` where applicable, `run_control_authorizations` where applicable) must separate:

  ```text
  execution_run_id  = canonical execution scope
  legacy run_id     = source PlanningRun provenance
  ```

  Historical values remain byte-identical.

- **Class-3 tables** (execution-only child tables) no longer need PlanningRunID as their scope key. They use `execution_run_id → execution_runs(execution_run_id)`; any retained planning provenance is secondary metadata only. Core queries and uniqueness constraints use ExecutionRunID.

`execution_runs` retains its required `sourcePlanningRunId` provenance, physically possibly still named `run_id` for migration economy — but schema/Core must expose its meaning explicitly, with `sourcePlanningRunId` as the preferred internal/domain naming. No execution service may treat this value as the execution scope identity.

---

# 8. Physical `execution_runs` Requirement

The post-A1 store must be capable of representing:

```text
ExecutionRun E1
sourcePlanningRunId = P
FinalPlan = F

ExecutionRun E2
sourcePlanningRunId = P
FinalPlan = F
```

simultaneously.

Therefore no effective constraint may enforce:

```text
UNIQUE(sourcePlanningRunId)

UNIQUE(FinalPlanRef)

one ExecutionRun per PlanningRun

one ExecutionRun per FinalPlan
```

on the canonical ExecutionRun table.

Canonical uniqueness is:

```text
PRIMARY/UNIQUE ExecutionRunID
```

---

# 9. Historical Migration Principle

Every existing pre-A1 ExecutionRun already contains a unique:

```text
execution_run_id
```

and historically had a 1:1 relationship with its PlanningRun.

Therefore migration must map:

```text
legacy execution world
    ↓
same existing execution_run_id
```

without generating a new execution identity.

Historical ExecutionRun IDs must not change.

---

# 10. Execution Child Migration

All existing execution-domain child rows must become unambiguously associated with the historical exact:

```text
ExecutionRunID
```

During migration the mapping is deterministic because pre-A1:

```text
PlanningRunID
→ exactly one historical ExecutionRun
```

for existing execution worlds.

Use that fact only for migration.

Do not preserve that 1:1 restriction after migration.

---

# 11. No Historical Semantic Rewrite

A1 migration must not alter historical:

```text
ExecutionRun lifecycle

FinalPlan binding

acceptedHead

Stage state

Window state

candidateRevision

Directive semantic content

Attempt state

Report content

Assessment content

ExecutionCommit chain

ExecutionIssue

Attempt reconciliation

abort provenance

Supervisor generation/history
```

Only execution identity linkage is normalized.

---

# 12. Directive Hash Compatibility

This is a hard invariant.

Historical:

```text
Directive protocol v1
Directive protocol v2
Directive protocol v3
```

canonical hashes must remain byte-identical.

Do NOT rewrite a historical hashed `run_id` field to `execution_run_id`.

---

# 13. New Directive Identity Binding

After A1, a newly issued Directive must be immutably bound to the exact:

```text
ExecutionRunID
```

not merely to source PlanningRunID.

If current v3 canonical payload cannot express this without changing v3 semantics:

```text
introduce Directive protocol v4
```

Required:

```text
v1 canonicalizer frozen
v2 canonicalizer frozen
v3 canonicalizer frozen
v4 binds exact ExecutionRunID
```

Do not add an unhashed execution-run binding to new Directives.

## 13.1 The v3 → v4 Revision Bridge (A1 Closure Amendment, Issue D)

Historical canonicalizers stay frozen forever:

```text
v1 canonicalizer = frozen
v2 canonicalizer = frozen
v3 canonicalizer = frozen
```

Historical rows retain:

```text
legacy run_id = historical PlanningRunID
historical directive_hash unchanged
```

Migration adds exact ExecutionRunID linkage without rewriting historical canonical content.

### v4 canonical identity

New v4 Directive canonical content binds BOTH:

```text
executionRunId: exact ExecutionRunID      (authority)

sourcePlanningRunId: immutable PlanningRun provenance
```

plus the existing exact:

```text
FinalPlan ref
scope
Stage/Window
base candidate
kind
policy/capabilities
content
```

as applicable.

`executionRunId` is authority.

`sourcePlanningRunId` is provenance.

### All new Directives after A1-I activation

```text
all newly issued Directives
→ protocolVersion = 4
```

No new v1/v2/v3 Directives are created.

Historical rows remain valid.

### Same logical Directive upgrade

A logical Directive that began before A1 may need a later revision after A1:

```text
DIR-X@1  protocol v3
Worker → blocked

migration A1-I

DIR-X@2 required
```

This MUST remain legal.

Freeze:

```text
v1/v2/v3
→ v4 next revision
```

is allowed only if Core can deterministically prove the historical lineage belongs to exactly one migrated:

```text
ExecutionRunID
```

Upgrade invariants for a historical → v4 revision:

```text
directiveId unchanged

revision = previous + 1

sourcePlanningRunId unchanged

ExecutionRunID =
    exact migrated ExecutionRun owning
    all previous revisions

FinalPlan unchanged

execution scope unchanged

Stage unchanged where applicable

Window unchanged

Directive kind unchanged
```

Existing revision-policy rules continue to apply.

### Protocol downgrade forbidden

Once a logical Directive has a v4 revision:

```text
all later revisions
→ v4
```

Forbidden:

```text
v4 → v3
v4 → v2
v4 → v1
```

No identity semantic downgrade.

### Cross-Run Directive reuse forbidden

Because two ExecutionRuns may now share one FinalPlan, Core must explicitly reject:

```text
historical DIR-X lineage from E1

reissued as revision under E2
```

even if:

```text
sourcePlanningRunId same
FinalPlan same
Stage sourceStepId same
content same
```

Directive lineage belongs to exactly one ExecutionRun.

### Reconciliation / verification / conflict compatibility

The same v4 bridge applies to:

```text
implementation
verification
inspection
conflict_resolution
```

Directives. E11 reconciliation may revise the same logical Directive lineage; after migration its revisions are v4 and bind the exact migrated ExecutionRun. Role/policy semantics remain E8/E10 semantics — only identity binding changes. No new reconciliation protocol is required solely because of A1.

### v4 physical mapping (Final Closure Amendment)

Post-A1 Directive rows conceptually contain:

```text
execution_run_id   exact execution authority scope
run_id             historical/source PlanningRun provenance
protocol_version
```

- Historical v1/v2/v3 rows: `run_id` remains the original PlanningRunID, hash unchanged, `execution_run_id` backfilled.
- v4 rows: `execution_run_id` = exact ExecutionRunID; `run_id` = sourcePlanningRunId provenance if the legacy physical column remains NOT NULL — its authority meaning is zero. The v4 hash binds explicit `executionRunId` + `sourcePlanningRunId`, never an ambiguous `runId`.

---

# 14. Other Immutable Artifacts

For immutable execution artifacts that are not canonical-hash versioned:

```text
Reports
Assessments
Commits
Conflicts
Reconciliations
Issues
Abort records
```

their canonical execution ownership must become exact:

```text
ExecutionRunID
```

Historical legacy PlanningRun provenance may remain separately available where useful.

---

# 15. SupervisorBinding

Supervisor ownership is per:

```text
ExecutionRunID
```

not per PlanningRun or FinalPlan.

Therefore:

```text
E1 and E2
```

from the same FinalPlan have completely independent:

```text
SupervisorBinding
generation
attached/detached state
```

Takeover of one ExecutionRun never fences the Supervisor of another independent ExecutionRun.

---

# 16. Worker Authority

Worker authority remains:

```text
ExecutionRun
→ Directive
→ Attempt
→ WorkerInvocation
```

After A1 every step must resolve to the same exact:

```text
ExecutionRunID
```

A Worker authorized for E1 must never be able to operate on E2 merely because both share:

```text
sourcePlanningRunId
FinalPlan
Workspace repository
```

---

# 17. acceptedHead Isolation

Every ExecutionRun owns its own:

```text
acceptedHead
```

For:

```text
FinalPlan F
→ E1
→ E2
```

required:

```text
E1.acceptedHead
independent of
E2.acceptedHead
```

E2 begins:

```text
acceptedHead = null
```

or the existing equivalent execution-start state.

E2 never inherits E1's ExecutionCommit chain.

---

# 18. Candidate / Window / Stage Isolation

Each ExecutionRun independently owns:

```text
ExecutionStages
VerificationWindows
candidateRevision lineage
```

Even when both runs derive from the same FinalPlan implementation order.

Normative sources may be identical.

Execution object identities are new.

---

# 19. Baseline Semantics

For multiple executions of the same FinalPlan:

## planningBaseline

```text
same approved planning evidence basis
```

may be referenced by every ExecutionRun.

It is immutable normative provenance.

## executionStartBaseline

must be freshly established for EACH ExecutionRun.

Therefore:

```text
E1.executionStartBaseline
may differ from
E2.executionStartBaseline
```

This difference is expected.

---

# 20. Initial PlanningRun Handoff Remains Exactly Once

A1 does NOT weaken E1.

The normal PlanningRun transition remains:

```text
PlanningRun P
FinalPlan F
    ↓
handoff_pending
    ↓
exactly one handoff-created ExecutionRun
    ↓
ExecutionRun active
PlanningRun completed
```

That first handoff remains idempotent and exactly once.

---

# 21. Handoff Is Not Reexecution

The original:

```text
PlanningRun → ExecutionRun
```

handoff represents the first execution delivery.

A later genuine reexecution does NOT:

```text
reopen PlanningRun
reset handoff_pending
delete handoff state
retry Final Approval
retry Final PlanCommit
```

Handoff history stays immutable.

---

# 22. `execution_handoffs`

`execution_handoffs` may remain exactly-one-per initial PlanningRun/FinalPlan delivery.

It must NOT impose:

```text
one total ExecutionRun per FinalPlan
```

on the wider architecture.

A reexecution does not require another PlanningRun handoff row.

If the current handoff row stores execution identity:

```text
it identifies the INITIAL handoff-created ExecutionRun
```

only.

---

# 23. Legacy `ExecutionBinding` — Fully Demoted From Live Execution Authority

E1 classified legacy ExecutionBinding as adapter/runtime metadata rather than normative execution authority.

A1 freezes (Closure Amendment, Issue B — Option B is now mandatory, not a choice):

> ExecutionBinding is NOT authoritative proof of current execution ownership, active execution, or current writable supervision.

Allowed meaning:

```text
historical/adapter provenance for the initial
PlanningRun handoff only, such as:

FinalPlan F
was initially delivered through handoff H
to first ExecutionRun E1
```

It may remain immutable.

It may remain one-per-initial-FinalPlan delivery.

It does not participate in FinalPlan → N ExecutionRun cardinality.

## Forbidden ExecutionBinding authority

Post-A1 code must not answer any of these questions using `ExecutionBinding`:

```text
Which ExecutionRun is currently active?

Who is the current Supervisor?

May this session mutate execution?

Is this FinalPlan currently being reexecuted?

Which execution must be detached?

Does this workspace currently have supervised execution?

Can planning safely mutate this workspace?
```

Those require canonical ExecutionRun / SupervisorBinding / WorkspaceIdentity state.

## Planning-control fence re-basing

The legacy planning-control fence ("run carries an ExecutionBinding") must NOT remain the canonical live-execution exclusion rule after A1.

Its semantic basis is replaced by:

```text
canonical nonterminal ExecutionRun state
+
WorkspaceIdentity
```

or the exact narrower canonical objects required by that planning operation.

`legacy ExecutionBinding detached` must never make an active reexecution invisible to planning controls.

## Replan / successor handling

E9 currently uses legacy binding state in parts of predecessor handling.

After A1, predecessor execution identity is:

```text
ExecutionIssue.predecessorExecutionRunId
```

or equivalent exact provenance.

Any operation that must detach/fence the predecessor execution must operate through:

```text
exact ExecutionRunID
SupervisorBinding
```

not by treating `ExecutionBinding` as the active execution owner.

The historical initial binding may remain untouched.

---

# 24. Reexecution Semantics

A genuine reexecution means:

```text
same exact immutable FinalPlan
+
new explicit execution authorization
+
new ExecutionRunID
+
fresh execution-start baseline
```

It is NOT:

```text
crash recovery
session resume
Supervisor takeover
Stage retry
Window continuation
replan
PlanningRun successor
```

---

# 25. Minimum Required v0.2.0 Reexecution Case

The implementation must support at least:

```text
FinalPlan F
→ ExecutionRun E1
→ aborted

same WorkspaceIdentity

explicit user-authorized reexecution

same FinalPlan F
→ ExecutionRun E2
```

This directly closes the frozen example:

```text
same FinalPlan may be executed again
after an explicitly abandoned execution
```

---

# 26. New Workspace Reexecution

The identity model must also NOT structurally prohibit:

```text
same FinalPlan F
→ E1 in Workspace A

same FinalPlan F
→ E2 in Workspace B
```

No automatic cross-workspace migration occurs.

These are independent execution runs.

---

# 27. Workspace Execution Serialization (Frozen)

A1 does not support parallel execution.

Freeze (Closure Amendment, Issue C):

> A WorkspaceIdentity may have at most one nonterminal execution authority at a time.

For A1:

```text
nonterminal =
    prepared
    or
    active
```

Therefore:

```text
one WorkspaceIdentity
→ at most one ExecutionRun in {prepared, active}
```

`prepared` is included deliberately: allowing E2 prepared beside E1 active (or two prepared runs) would already create competing future execution authority and ambiguous baseline/runtime ownership.

Terminal runs do not consume the workspace's nonterminal execution slot:

```text
completed
replan_required
aborted
```

are terminal. Therefore valid:

```text
E1 aborted
same WorkspaceIdentity
→ E2 prepared
```

and later:

```text
E2 active
```

Historical completed/replan-required Runs remain queryable.

The workspace singleton does not restrict the same FinalPlan executing in different workspaces:

```text
FinalPlan F
→ E1 active in Workspace A

FinalPlan F
→ E2 active in Workspace B
```

provided every other authorization invariant is satisfied. They are independent execution worlds; no automatic cross-workspace migration exists.

This is workspace/run lifecycle safety, not `one Run per FinalPlan`.

## Enforcement

A1-I must prefer a Core + DDL invariant equivalent to:

```text
UNIQUE WorkspaceIdentity
WHERE lifecycle IN ('prepared', 'active')
```

if SQLite/schema design permits it cleanly (a partial unique index over the canonical execution_runs table satisfies this).

At minimum the invariant must be transactionally enforced.

A read-then-insert race without durable uniqueness is insufficient.

## Reexecution authorization must check the workspace slot

Before creating E2:

```text
target workspace
must contain no prepared/active ExecutionRun
```

If occupied:

```text
fail closed
```

Do not silently:

```text
reuse
take over
abort
migrate
supersede
```

the existing Run.

---

# 28. Reexecution Authorization

Creation of another ExecutionRun from an already delivered FinalPlan is a new durable execution-authority event.

Freeze for v0.2.0:

```text
genuine reexecution requires explicit human authorization
```

Reuse the existing Host control pattern:

```text
requiresUserInteraction
PreToolUse → ask
human confirmation
durable run-control/idempotency record
```

Do not create a second approval subsystem.

The durable authorization record uses the typed run-control target model (§49): a reexecution authorization is a `final_plan_execution` target, never a planning-run or existing-execution-run target.

---

# 29. Reexecution Is User-Control Authority

Reexecution does NOT require:

```text
current Supervisor ownership of an old Run
```

because the old Run may be:

```text
aborted
completed
or in another workspace
```

The user authorizes the new ExecutionRun.

Supervisor authority begins only after the new Run is prepared/activated and bound.

---

# 30. Reexecution Request

Conceptually the request identifies:

```text
exact FinalPlanRef

target WorkspaceIdentity

operation/idempotency identity
```

Core derives:

```text
sourcePlanningRunId
planningBaseline
new ExecutionRunID
fresh executionStartBaseline
Stage decomposition
```

Never accept:

```text
latest plan
current plan
previous plan
```

as authority.

The authorization record binds the typed `final_plan_execution` target exactly:

```text
sourcePlanningRunId
exact FinalPlan ID/revision/hash
target WorkspaceIdentity
operation identity / authorization nonce
```

Final Closure Amendment — atomic, append-only authorization: `run_control_authorizations` is append-only and receives NO post-hoc UPDATE. There is no durable pre-creation authorization row: the Host's user approval occurs before the transaction and never requires a partially populated control row. The successful reexecution is ONE transaction:

```text
human Host authorization already granted

BEGIN IMMEDIATE

validate exact FinalPlanExecutionTarget

validate workspace nonterminal slot

arbitrate idempotency

generate new ExecutionRunID = E2

derive fresh execution-start baseline

persist control authorization row with:
    target_kind = final_plan_execution
    exact FinalPlan target
    resulting_execution_run_id = E2

create ExecutionRun E2 = prepared

materialize required execution structure

append audit/control events

COMMIT
```

Exact insert ordering may differ for deferred FK mechanics. The semantic requirement:

> No committed successful reexecution authorization exists without its exact resulting ExecutionRunID.

If creation fails, the transaction rolls back — no control row, no E2 — and the user may authorize/retry again per existing Host/control semantics.

Successful-row shape (`target_kind = final_plan_execution`, committed):

```text
sourcePlanningRunId NOT NULL
exact FinalPlan identity NOT NULL
WorkspaceIdentity NOT NULL
execution_run_id = NULL        // no preexisting run is the target
resulting_execution_run_id NOT NULL
   → exact newly created ExecutionRun
```

The target is FinalPlan+Workspace; the outcome is E2. Do not conflate them.

Retry of the SAME control operation identity: load the existing authorization, validate exact target/hash, read `resulting_execution_run_id = E2`, and return/converge on E2. No E3, no second authorization, no mutation of the existing row.

Idempotency identity includes the typed target: the same operation id against a different target kind, ExecutionRunID, FinalPlanRef, or WorkspaceIdentity is a conflict, never a replay.

---

# 31. Reexecution Lifecycle

A genuine reexecution creates:

```text
NEW ExecutionRun.prepared
```

then normal runtime activation:

```text
prepared → active
```

It does not reactivate another Run.

---

# 32. PlanningRun Side Effects

Reexecution activation must NOT perform:

```text
PlanningRun → completed
```

because the source PlanningRun is already completed.

Therefore implementation must separate:

```text
ExecutionRun activation
```

from:

```text
initial handoff's PlanningRun-completion side effect
```

while preserving E1's original atomic handoff.

---

# 33. Reexecution Idempotency

One authorized operation identity creates:

```text
exactly one new ExecutionRun
```

Retry converges to the same prepared/active Run.

A later distinct explicitly authorized reexecution may create another ExecutionRun.

---

# 34. Reexecution Does Not Copy Plan Memory

Do not duplicate:

```text
Decision
Constraint
Architecture
Section
FinalPlan
```

rows merely to satisfy foreign keys.

The same exact immutable approved Plan objects are referenced.

---

# 35. Reexecution Does Not Inherit Execution Memory

Do not copy as authority:

```text
Stages
Windows
Directives
Attempts
Reports
Assessments
Commits
acceptedHead
reconciliations
```

from an earlier Run.

A new execution world begins from its own:

```text
executionStartBaseline
```

under the same FinalPlan.

---

# 36. `replan_required` Remains Distinct

E9 semantics are unchanged.

```text
execution discovers normative insufficiency
→ ExecutionIssue
→ replan_required
→ NEW PlanningRun
→ amended/reconfirmed FinalPlan
→ NEW ExecutionRun
```

This remains separate from:

```text
same unchanged FinalPlan
→ explicit reexecution
```

Do not collapse these two paths.

---

# 37. Completed Run Remains Distinct

A completed Run is never reactivated.

If an explicitly authorized later execution of the same FinalPlan is allowed:

```text
create a NEW ExecutionRun
```

Do not mutate the completed Run.

---

# 38. Aborted Run Remains Distinct

An aborted Run is never resumed.

Reexecution after abort:

```text
aborted E1
+
same FinalPlan
→ NEW E2
```

not:

```text
E1 aborted → active
```

---

# 39. Crash / Resume Rule Remains

Crash, `/clear`, fork, compaction, rewind, Supervisor takeover, and Worker recovery NEVER create a new ExecutionRun.

They recover:

```text
the SAME ExecutionRunID
```

A1 must not weaken this.

---

# 40. Storage Migration Requirement

A1 implementation will require an explicit migration after schema 25.

Expected:

```text
025 → 026
```

This migration is authorized only AFTER this amendment is reviewed/frozen.

The migration must make:

```text
ExecutionRunID
```

the execution-domain identity without rewriting historical semantic history.

---

# 41. Migration Strategy Requirements

Implementation must first produce a complete affected-table map.

At minimum audit:

```text
execution_runs
execution_run_events
execution_handoffs
execution_bindings

supervisor_bindings
execution_stages
verification_windows
execution_directives
execution_attempts
execution_worker_invocations
execution_reports

supervisor_assessments
execution_commits

verification_conflicts
attempt_reconciliation bindings/results

execution_issues
execution_abort_records

run_control_authorizations

recovery/projection helper tables
```

Do not assume the uploaded E14 audit's "~20 tables" is exact.

Prove the actual set.

---

# 42. Migration Backfill

For every historical execution-domain row:

```text
legacy PlanningRun-scoped key
    ↓
historical execution_runs row
    ↓
exact historical execution_run_id
```

must deterministically backfill new execution ownership.

If any historical row cannot be mapped uniquely:

```text
migration fails closed
```

No heuristic.

## Historical run-control authorization classification (revised by Final Closure Amendment)

Every existing `run_control_authorizations` row classifies by explicit durable structural relationships only. Timestamp ordering is audit evidence, never a semantic relation; it is never used to select planning vs execution.

Migration-only compatibility target:

```text
legacy_pre_a1
```

means: "this row is an authentic immutable pre-A1 control record whose precise planning-vs-execution target was not structurally encoded at the time." It does NOT mean "unknown authority that may be guessed later." It is NOT a valid target for newly created authorizations.

Required classification precedence:

```text
1. execution_abort_records.control_id
   points to this control
      → execution_run
      → exact historical ExecutionRunID

2. durable execution-specific relation
   with an exact control-id/authorization-id FK,
   if the implementation audit finds one
      → execution_run

3. no ExecutionRun has ever existed for
   the historical PlanningRun
   AND execution rows are immutable/non-deletable
      → planning_run

4. otherwise
      → legacy_pre_a1
```

Never classify from:

```text
created_at ordering
same-second ordering
session coincidence
request prose
conversation history
```

A pre-A1 control row is historical audit data; it does not need to become fresh mutation authority after migration. Historical truth ("this exact control operation happened") is preserved; an unprovable stronger truth ("it definitely targeted planning/execution") is not fabricated.

## `legacy_pre_a1` cannot authorize new mutation

After A1-I, a `legacy_pre_a1` row may only participate in:

```text
historical audit
exact idempotent replay of
an already-committed historical operation
```

It may NOT authorize:

```text
new planning mutation
new execution mutation
takeover
abort
reexecution
```

No new row may be inserted with this target kind; application insert APIs reject it after migration.

A migrated legacy row satisfies an exact retry only when all frozen historical request identity matches:

```text
same operation_id
same authorization_request_id (where applicable)
same operation
same request_hash
same workspace identity
same legacy run_id
```

The retry returns/converges on the already-durable historical outcome; it never executes another mutation. Any mismatch is `IDEMPOTENCY_CONFLICT` (or the repository-equivalent stable error).

## New control-target pair matrix

For every NEW post-A1 authorization row, legal `target_kind + operation` pairs are exactly:

```text
target_kind = planning_run
operation   = planning takeover/abort surface

target_kind = execution_run
operation   = execution takeover/abort surface

target_kind = final_plan_execution
operation   = reexecute_final_plan
```

Exact operation strings follow repository naming. The invariant: `target_kind + operation` forms an explicit legal pair. Operation name alone never determines the target; identifier presence alone never determines the target.

## Structural error vs legacy semantic ambiguity (revised preflight)

The A1-I preflight distinguishes:

```text
STRUCTURAL ERROR
vs
LEGACY SEMANTIC AMBIGUITY
```

Structural errors (fail migration):

```text
orphan execution child

multiple legacy ExecutionRuns for a supposedly
bijective pre-A1 PlanningRun

broken FinalPlan FK

conflicting exact abort-control pointer
```

Historical control-target ambiguity maps to `legacy_pre_a1` and does NOT fail migration — the migration succeeds with the legacy row. Migration fails only for corrupted structural facts, never for semantic ambiguity that `legacy_pre_a1` honestly represents.

## Workspace singleton preflight

Before the post-A1 uniqueness invariant is installed, the migration must prove no existing workspace holds two nonterminal (`prepared`/`active`) ExecutionRuns. Any violation fails closed.

## Directive lineage proof preflight

For every logical Directive lineage, the migrated `execution_run_id` linkage must be single-valued across all its revisions before any v4 upgrade is legal. A lineage that cannot be proven to belong to exactly one ExecutionRun fails closed and is permanently ineligible for the v3→v4 bridge.

---

# 43. Historical Hash Preservation

Before migration:

capture representative real:

```text
Directive v1 hash
Directive v2 hash
Directive v3 hash
```

After migration:

```text
byte-identical
```

required.

If new Directive protocol v4 is needed:

```text
historical canonicalizers remain untouched.
```

---

# 44. Historical External IDs

Do not change historical:

```text
Directive IDs
Attempt IDs
Report IDs
Assessment IDs
Commit IDs
Window IDs
Stage IDs
Issue IDs
Abort IDs
```

A1 is identity-linkage normalization, not object recreation.

---

# 45. ExecutionCommit Chain

Each existing commit chain must remain attached to its original exact:

```text
ExecutionRunID
```

Parent sequence/order unchanged.

After migration no Commit from E1 may appear under E2.

---

# 46. acceptedHead Migration

Historical acceptedHead must point to a Commit belonging to the same exact:

```text
ExecutionRunID
```

Validator must enforce it.

No acceptedHead sharing across runs.

---

# 47. Supervisor Generation Migration

Historical SupervisorBinding maps to its exact historical ExecutionRun.

Generation numbers remain unchanged.

No generation reset during identity migration.

---

# 48. Worker Runtime Migration

Historical Worker invocation bindings remain attached to exact historical:

```text
Attempt
Directive
ExecutionRun
```

Launch/claim tokens are not regenerated merely because schema identity changes.

---

# 49. Run-Control Authorization — Typed Targets

`run_control_authorizations` is shared control infrastructure: it already serves planning-tier and execution-tier operations. Post-A1 it must NOT simply redefine `run_id` as ExecutionRunID or require `execution_run_id NOT NULL` on every row — that would make planning-level control semantically invalid.

Freeze the typed target model (Closure Amendment, Issue A):

```ts
type RunControlTarget =
  | {
      kind: "planning_run"
      planningRunId: PlanningRunID
    }
  | {
      kind: "execution_run"
      executionRunId: ExecutionRunID
    }
  | {
      kind: "final_plan_execution"
      sourcePlanningRunId: PlanningRunID
      finalPlan: ExactFinalPlanRef
      workspaceIdentity: WorkspaceIdentity
    }
  | {
      kind: "legacy_pre_a1"   // migration-only compatibility kind (§42)
      legacyRunId: PlanningRunID
    }
```

Exact SQL representation belongs to A1-I; the semantics are frozen here.

- **planning_run** — operations whose authoritative object already exists in planning (existing planning-level takeover/abort). `planningRunId` required; `executionRunId` null. Planning control must not be forced through an ExecutionRun merely because the shared authorization table also serves execution operations.
- **execution_run** — operations that mutate an already-existing ExecutionRun (execution Supervisor takeover, ExecutionRun abort). The authority target is the exact ExecutionRunID — not the source PlanningRunID, not the FinalPlanID alone, not the workspace alone. Planning provenance may be derived/read separately.
- **final_plan_execution** — same-FinalPlan reexecution. Binds exactly `sourcePlanningRunId` + exact FinalPlan ID/revision/hash + target WorkspaceIdentity + operation identity/authorization nonce. The row is created ATOMICALLY with the new ExecutionRun (§30): `resulting_execution_run_id` is already set at commit, and the append-only table never receives an UPDATE.
- **legacy_pre_a1** — migration-only compatibility kind for authentic pre-A1 rows whose planning-vs-execution target was never structurally encoded (§42). It cannot authorize new mutation, cannot be inserted post-migration, and participates only in historical audit and exact idempotent replay of an already-committed operation.

Append-only rule (Final Closure Amendment): no committed successful reexecution authorization exists without its exact resulting ExecutionRunID, and no authorization row is ever updated to add one. If creation fails, the transaction rolls back — no control row, no new run.

New-row legal pairs are exactly `planning_run × planning takeover/abort`, `execution_run × execution takeover/abort`, `final_plan_execution × reexecute_final_plan` (exact operation strings follow repository naming). Operation name alone never determines the target; identifier presence alone never determines the target.

Legacy `run_id` column on this table: it may remain historical PlanningRun provenance for migrated records; new typed rows use the explicit target columns and never the legacy column as target authority. If keeping it NOT NULL creates artificial semantics for new execution-target rows, make it nullable or populate it only with clearly defined source-planning provenance. The typed columns and `target_kind` remain canonical.

---

# 50. ExecutionIssue Provenance

E9 successor PlanningRun provenance must reference exact:

```text
predecessorExecutionRunId
```

not source PlanningRunID disguised as Run identity.

Historical issues must be backfilled accordingly.

---

# 51. Abort Provenance

ExecutionAbort remains one-to-one with exact:

```text
ExecutionRunID
```

Two executions of the same FinalPlan may have independent abort histories.

---

# 52. Recovery Context

Recovery must render both identities unambiguously where useful:

```text
PlanningRun source: PLAN-X
FinalPlan: FINAL-Y
ExecutionRun: EXEC-Z
```

Do not render one ambiguous:

```text
Run: ...
```

where it can be misunderstood.

---

# 53. Model-Facing Naming

New or revised execution APIs should prefer:

```text
execution_run_id
```

for execution identity.

Use:

```text
planning_run_id
```

for planning identity.

Avoid introducing new ambiguous `run_id` parameters.

Where backward compatibility requires accepting legacy fields:

```text
normalize explicitly
reject ambiguity
```

and document deprecation.

---

# 54. Architecture Invariants Added by A1

A1 freezes:

```text
A1-I1
PlanningRunID and ExecutionRunID are distinct authority identities.

A1-I2
ExecutionRunID is the canonical identity of Execution Memory.

A1-I3
sourcePlanningRunId is immutable provenance, not ExecutionRun identity.

A1-I4
One exact FinalPlan may bind 0..N ExecutionRuns.

A1-I5
No FinalPlan copy is required for reexecution.

A1-I6
Initial PlanningRun handoff remains exactly once.

A1-I7
Reexecution never reopens or mutates the original PlanningRun.

A1-I8
Reexecution creates a new ExecutionRun rather than reactivating one.

A1-I9
Each ExecutionRun has an independent executionStartBaseline.

A1-I10
Each ExecutionRun has independent Stage/Window/Directive/Attempt/Report/Commit history.

A1-I11
Each ExecutionRun has an independent acceptedHead.

A1-I12
SupervisorBinding and fencing are per ExecutionRun.

A1-I13
Worker authority is bound to exact ExecutionRun.

A1-I14
Crash/resume never creates a new ExecutionRun.

A1-I15
REPLAN_REQUIRED remains distinct from reexecution.

A1-I16
Historical execution object IDs remain unchanged through migration.

A1-I17
Historical Directive v1/v2/v3 hashes remain byte-identical.

A1-I18
New immutable Directive authority binds exact ExecutionRunID.

A1-I19
Legacy run_id may not remain an execution authority key.

A1-I20
Execution handoff metadata cannot impose FinalPlan→1 ExecutionRun cardinality.

A1-I21
Explicit reexecution is human-authorized and idempotent.

A1-I22
Same FinalPlan may be reexecuted after an aborted Run without reopening planning.

A1-I23
Different ExecutionRuns of one FinalPlan never share mutable Execution Memory.

A1-I24
Workspace identity remains stable per ExecutionRun; no automatic migration is introduced.

A1-I25
No existing terminal Run is ever reactivated or rebound.

A1-I26
Run-control authority has an explicit typed target.

A1-I27
Planning control authorization never requires an ExecutionRun target.

A1-I28
Existing ExecutionRun control authorization targets exact ExecutionRunID.

A1-I29
Reexecution authorization targets exact FinalPlanRef + WorkspaceIdentity before the new Run exists.

A1-I30
ExecutionBinding is historical initial-handoff metadata only and never live execution authority.

A1-I31
Planning/execution exclusion fences use canonical ExecutionRun state, not legacy ExecutionBinding presence.

A1-I32
At most one prepared-or-active ExecutionRun exists per WorkspaceIdentity.

A1-I33
Terminal Runs do not prevent a later Run in the same WorkspaceIdentity.

A1-I34
Different workspaces may independently execute the same FinalPlan.

A1-I35
Historical Directive v1/v2/v3 canonicalizers and hashes remain frozen.

A1-I36
All newly issued post-migration Directives are v4.

A1-I37
v4 canonically binds exact ExecutionRunID and sourcePlanningRunId.

A1-I38
Historical logical Directive lineage may upgrade to v4 without changing its ExecutionRun identity.

A1-I39
Directive lineage can never move between ExecutionRuns.

A1-I40
Protocol downgrade from v4 is forbidden.

A1-I41
Historical control target semantics are never inferred from timestamp ordering.

A1-I42
Unprovable pre-A1 control target distinctions are represented explicitly as legacy_pre_a1.

A1-I43
legacy_pre_a1 rows cannot authorize new mutation.

A1-I44
A successful reexecution authorization is append-only and already contains its resulting ExecutionRunID at commit.

A1-I45
Reexecution authorization and ExecutionRun creation are atomic.

A1-I46
No retained legacy PlanningRunID field is used as canonical execution scope.

A1-I47
No post-A1 FK depends on execution_runs.run_id as an execution identity.

A1-I48
Historical v1/v2/v3 Directive run_id values remain PlanningRun provenance and byte-stable.

A1-I49
v4 separates executionRunId authority from sourcePlanningRunId provenance explicitly.

A1-I50
Legacy control ambiguity is preserved honestly rather than guessed or treated as corruption.
```

---

# 55. Implementation Decomposition After Amendment Freeze

Do NOT implement all of A1 in one uncontrolled patch.

After this architecture amendment is approved, use three implementation stages.

## A1-I — Execution Identity Migration

Scope:

```text
schema 25 → 26

ExecutionRunID canonicalization

affected-table backfill

service/store re-plumbing

Supervisor/Worker authority re-key

historical hash compatibility

NO reexecution tool yet
```

Exit requirement:

```text
all historical E1–E14 behavior
works unchanged under ExecutionRunID identity
```

---

## A1-II — Explicit Same-FinalPlan Reexecution

Scope:

```text
human-authorized reexecution control

same FinalPlan
→ new prepared ExecutionRun

fresh executionStartBaseline

independent Stage/Window materialization

activation without PlanningRun mutation

idempotency
```

Exit proof:

```text
FinalPlan F
→ aborted E1
→ same FinalPlan F
→ active E2
```

---

## A1-III — E14 Closure Resumption

Scope:

```text
E14C-T1..T11

all existing E14 integrated suites

full migration matrix

full E1–E13 regression

full npm test

re-evaluate E14-I1..I40
```

Only A1-III may restore:

```text
E14 FORMAL PASS

PHASE PLAN v0.2.0 ARCHITECTURE IMPLEMENTATION CLOSED
```

---

# 56. Documentation Requirement

Persist this amendment as a separate architecture artifact, for example:

```text
docs/SPEC/
claude-code-phase-plan-v0.2.0-architecture-amendment-A1-execution-run-identity.md
```

Do NOT silently rewrite the original frozen v0.2.0 specification as though the mismatch never existed.

Add a short amendment notice/reference to the baseline spec only if repository documentation conventions support it.

The historical baseline remains auditable.

---

# 57. Required Architecture-Amendment Report

For this documentation-only stage return:

## A. DDL Audit

Exact affected tables/constraints.

## B. Identity Map

For every execution-domain object:

```text
current scope key
post-A1 scope key
historical backfill path
hash compatibility concern
```

## C. Handoff / ExecutionBinding Audit

State exactly how:

```text
execution_handoffs
execution_bindings
```

will stop enforcing total FinalPlan 1:1 execution cardinality while preserving initial handoff semantics.

## D. Directive Compatibility

State whether:

```text
protocol v4
```

is required and why.

No implementation yet.

## E. Migration Plan

Exact table-rebuild/backfill dependency order.

No code yet.

## F. API Surface Map

List every model-facing/internal API currently using ambiguous:

```text
run_id
```

and classify:

```text
PlanningRunID
ExecutionRunID
legacy compatibility
```

## G. Implementation Staging

Return concrete:

```text
A1-I
A1-II
A1-III
```

boundaries and Exit Gates.

## H. Amendment Invariants

Return:

```text
A1-I1 ... A1-I25
```

PASS as design coverage, not implementation status.

Then exactly:

```text
A1 ARCHITECTURE AMENDMENT READY FOR REVIEW
```

---

# 58. STOP

This is documentation/architecture work only.

Do NOT create:

```text
migration 026
reexecution tool
Directive protocol v4
schema changes
production-code identity rewrites
```

until this amendment has been reviewed and frozen.

E14 remains:

```text
E14 NOT CLOSED
```

during the amendment process.

---

# Revision History

## 2026-10-03 — A1 Closure Amendment

Resolved the four remaining architectural ambiguities after the original A1 proposal review. All accepted A1 conclusions retained (distinct identities; ExecutionRunID canonical; sourcePlanningRunId required provenance; FinalPlan → 0..N ExecutionRuns; schema 25 → 26 required; historical object IDs and Directive v1/v2/v3 hashes preserved; Directive protocol v4 required; A1-I/II/III staging retained). No implementation authorized.

- **Issue A — typed run-control targets (§49 revised, §42 extended):** `run_control_authorizations` serves both planning and execution control; rows are no longer definable by a single ambiguous `run_id`. Frozen `RunControlTarget` model with `planning_run` / `execution_run` / `final_plan_execution` kinds, per-kind identifier requirements, operation-validated target shape, target-specific idempotency, and deterministic historical-row classification (fail-closed residual).
- **Issue B — ExecutionBinding demotion (§23 revised):** Option B frozen as mandatory. `execution_bindings` is historical initial-handoff provenance only; the enumerated live-authority questions must move to canonical ExecutionRun / SupervisorBinding / WorkspaceIdentity state; the planning-control fence is re-based on nonterminal ExecutionRun state + WorkspaceIdentity; replan/successor predecessor handling operates through exact ExecutionRunID + SupervisorBinding and `ExecutionIssue.predecessorExecutionRunId`.
- **Issue C — workspace execution serialization (§27 revised):** at most one `prepared`/`active` ExecutionRun per WorkspaceIdentity, transactionally enforced (partial unique index preferred); terminal runs never consume the slot; different workspaces independently execute the same FinalPlan; reexecution authorization checks the slot and fails closed when occupied.
- **Issue D — Directive v3→v4 bridge (§13.1 added, §42 extended):** v4 canonical content binds `executionRunId` (authority) + `sourcePlanningRunId` (provenance); all post-migration issuance is v4; frozen v1/v2/v3; deterministic historical-lineage upgrade rules with unchanged identity/scope; protocol downgrade forbidden; cross-run lineage reuse forbidden; reconciliation and conflict-resolution revision bridges included.
- **Invariants extended:** A1-I26..A1-I40 added to §54 (40 total).

## 2026-10-03 — A1 Final Closure Amendment

Corrected three items of the closure revision; everything else retained. No implementation authorized.

- **Problem 1 — historical classification:** the timestamp-order target classifier is REMOVED entirely (not kept as fallback). Historical control rows classify only by explicit durable structural relations (abort-record control-id pointer; other exact control-id/authorization-id FKs; absence of any ExecutionRun for the planning run); the unprovable remainder maps to the migration-only `legacy_pre_a1` compatibility kind and migration succeeds. `legacy_pre_a1` cannot authorize new mutation, cannot be inserted post-migration, and supports only historical audit plus exact idempotent replay of an already-committed operation (`IDEMPOTENCY_CONFLICT` on mismatch). Preflight now distinguishes STRUCTURAL ERROR (fails migration) from LEGACY SEMANTIC AMBIGUITY (represented honestly, never fails).
- **Problem 2 — append-only authorization:** the post-creation write of `resulting_execution_run_id` is removed. Reexecution authorization and ExecutionRun creation are ONE transaction: the control row is persisted with `resulting_execution_run_id` already set, `execution_run_id` NULL (no preexisting run is the target), and the append-only table never receives an UPDATE. No durable pre-creation authorization row exists; failure rolls back both. Retry converges by reading the resulting id — no second authorization, no E3.
- **Problem 3 — legacy FK domains:** after the re-key `execution_runs.run_id` is no longer unique; no post-A1 FK may target `execution_runs(run_id)`. Retained legacy `run_id` fields mean source PlanningRunID provenance with FK domain `planning_runs(run_id)` and/or the composite planning-owned FinalPlan FK; Class-1 tables (directives, issues, handoffs, control authorizations) separate `execution_run_id` authority from frozen provenance columns; Class-3 tables scope exclusively by `execution_run_id`; `execution_runs` keeps required `sourcePlanningRunId` provenance (possibly still physically named `run_id`, never treated as scope identity); the control table's legacy column becomes nullable-or-defined-provenance rather than target authority.
- **Invariants extended:** A1-I41..A1-I50 added to §54 (50 total).
