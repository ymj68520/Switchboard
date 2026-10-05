# Claude Code Phase Plan v0.2.0 — Architecture Specification

**Status:** Frozen architecture baseline  
**Version:** 0.2.0  
**Scope:** Claude Code implementation of Phase Plan with supervised execution  
**Entry point:** `/phase-plan`  
**Supersedes:** v0.1 architecture where explicitly amended by this document  
**Amendments:** A1 — ExecutionRun identity independence + same-FinalPlan reexecution, revised by the A1 Closure and Final Closure Amendments (typed run-control targets incl. migration-only `legacy_pre_a1`, append-only atomic reexecution authorization, ExecutionBinding authority demotion, workspace execution serialization, Directive v3→v4 bridge, legacy FK-domain rules) — proposed, pending review: `claude-code-phase-plan-v0.2.0-architecture-amendment-A1-execution-run-identity.md`

---

## 1. Purpose

Phase Plan v0.2.0 extends the v0.1 planning harness into a supervised execution harness without weakening the existing planning authority model.

The v0.1 architecture established an immutable, evidence-backed, user-approved Final Plan and then handed the session to an execution-tier model under a read-only plan contract. v0.2.0 keeps that planning model intact and adds a second durable lifecycle after Final Approval:

```text
PlanningRun
    ↓
approved immutable FinalPlan
    ↓
ExecutionRun
    ↓
Supervisor-directed execution
    ↓
Executor / Verifier work
    ↓
ExecutionCommit chain
    ↓
ExecutionRun completion
```

The primary product goal is:

> **Use frontier-model reasoning for sparse, high-value execution supervision while delegating high-volume repository work to an execution-tier model under explicit, immutable, auditable Directives.**

The system is designed to support both:

```text
simple task
    → detailed plan
    → one or a few work packages
    → verification
    → complete
```

and:

```text
complex task
    → architecture design
    → approved Final Plan
    → staged execution
    → repeated implementation / verification windows
    → final execution closure
```

without introducing a separate prompt-complexity classifier or a separate architecture for “simple” and “complex” execution.

---

## 2. v0.2.0 Amendment Summary

v0.2.0 preserves the following v0.1 guarantees:

- PlanningRun remains independent of conversation history.
- Approved Plan Memory remains immutable except through the formal Proposal / Approval / PlanCommit pipeline.
- Final Plan remains an immutable structured snapshot of exact approved revisions.
- Final Approval remains the only authorization for normal Plan → execution handoff.
- Completed PlanningRuns are never reactivated.
- Build/execution cannot mutate committed Plan Memory.
- Model-facing operations remain typed domain capabilities rather than raw state mutation APIs.
- Core owns authoritative lifecycle/state transitions.
- Host runtime permissions are not bypassed by plan approval.
- Workspace identity remains distinct from repository identity.
- Session ownership uses explicit binding and fencing semantics.

v0.2.0 explicitly amends the v0.1 execution model by replacing the lightweight post-plan handoff with a durable supervised-execution protocol.

The following v0.1 assumptions are no longer valid in v0.2.0:

```text
ExecutionHandoff → free Build execution

no separate execution progress state machine

execution progress orchestration is a non-goal
```

They are replaced with:

```text
FinalPlan
    ↓
ExecutionRun
    ↓
ExecutionStage
    ↓
VerificationWindow
    ↓
ExecutionDirective
    ↓
ExecutionAttempt
    ↓
ExecutionReport
    ↓
SupervisorAssessment
    ↓
ExecutionCommit
```

Execution supervision is now a core Phase Plan responsibility.

---

## 3. Top-Level Authority Boundary

The v0.2.0 authority model is:

```text
User
    owns approval authority for normative design

Planning Agent
    performs planning reasoning

Execution Supervisor
    performs execution decomposition and semantic judgment

Executor / Verifier
    perform repository/runtime work

Phase Plan Core
    owns authoritative workflow state transitions

Phase Plan Store
    owns durable canonical persistence

Claude Code
    owns conversation, model invocation, repository tools,
    shell/tool execution, permission primitives, and runtime mechanics
```

The fundamental boundary is:

> **Claude Code owns execution mechanics; Phase Plan owns supervised-execution protocol truth.**

The Execution Supervisor is not the Core.

The Executor is not the Supervisor.

The Verifier is not a privileged validator.

The model proposes or reports domain intent/results; Core determines authoritative transitions.

---

## 4. Three Trust Domains

v0.2.0 separates three kinds of truth.

### 4.1 Plan Memory

Plan Memory is approved normative truth.

It contains exact approved revisions of concepts such as:

```text
Architecture
Sections
SectionContracts
Decisions
Constraints
resolved design Questions / Conflicts
FinalPlan
```

Execution cannot mutate it.

### 4.2 Workspace

The workspace is mutable physical reality.

It includes:

```text
source files
working tree changes
build outputs
temporary artifacts
repository state
external side effects produced by authorized tools
```

Workspace changes are not automatically accepted execution progress.

### 4.3 Execution Memory

Execution Memory is durable supervised-execution truth.

It contains concepts such as:

```text
ExecutionRun
ExecutionStage
VerificationWindow
ExecutionDirective
ExecutionAttempt
ExecutionReport
SupervisorAssessment
ExecutionCommit
ExecutionIssue
bindings / audit history
```

Only an `ExecutionCommit` advances authoritative accepted execution progress.

Therefore:

```text
workspace changed
    ≠
execution progress accepted
```

and:

```text
execution-derived fact
    ≠
approved Plan Memory fact
```

---

## 5. Model Policy

v0.2.0 uses role-oriented model tiers:

```text
planning_model   = frontier planning tier
supervisor_model = frontier reasoning tier
executor_model   = balanced execution tier
verifier_model   = execution tier by default
```

The concrete Claude model names belong to the Claude adapter, not the provider-neutral Core.

The architecture does not require Executor and Verifier to use different model families.

By default:

```text
Executor = execution-tier model
Verifier = execution-tier model
```

A future adapter may configure a stronger Verifier model without changing the protocol.

The intended economic pattern is:

```text
frontier model
    sparse high-value reasoning

execution-tier model
    dense repository/tool labor
```

v0.2.0 does not introduce prompt-complexity-based model routing.

---

## 6. Planning Lifecycle Remains Separate

PlanningRun remains the authoritative planning lifecycle object.

Execution is not a PlanningRun stage.

Conceptually:

```text
PlanningRun
    discovery
    architecture
    detail
    synthesis
    validation
    final

Final Approval
    ↓
Final PlanCommit
    ↓
handoff_pending
```

PlanningRun continues to use the v0.1 Proposal / Approval / PlanCommit model.

Completed PlanningRuns are never reactivated.

If execution later discovers a planning defect, the system creates a new PlanningRun rather than reopening the completed run.

---

## 7. Final Plan as Normative Execution Contract

The Final Plan is not merely a handoff summary.

In v0.2.0 it is the immutable normative execution contract.

It defines or references:

```text
goal
approved architecture
hard constraints
invariants
approved interfaces
SectionContracts
approved Decisions
dependency constraints
implementation obligations
validation requirements
known limitations
implementation order / sequencing guidance
```

The Final Plan answers:

> **What must be true when execution is complete?**

It does not need to pre-encode every low-level repository action.

Low-level implementation instructions are produced just in time by the Execution Supervisor as `ExecutionDirective` objects.

The Final Plan remains bound to exact approved revisions and never changes in place.

---

## 8. PlanningRun → ExecutionRun Handoff

### 8.1 Recoverable handoff

The transition is:

```text
Final Approval
    ↓
Final PlanCommit
    ↓
PlanningRun = handoff_pending
    ↓
create / recover exact ExecutionRun = prepared
    ↓
bind supervised execution runtime
    ↓
ExecutionRun = active
    ↓
PlanningRun = completed
```

The Final Plan is committed before execution authority becomes active.

`handoff_pending` remains a recoverable transition condition.

### 8.2 Crash consistency

The system must not allow:

```text
PlanningRun completed
but no durable ExecutionRun exists
```

ExecutionRun creation during handoff is idempotent.

A crash during handoff must recover the same prepared ExecutionRun rather than creating a duplicate.

### 8.3 Authorization semantics

Final Approval authorizes:

```text
execution of this exact FinalPlan
under the Phase Plan supervised-execution protocol
```

It does not authorize bypassing host tool permissions.

It also does not require the user to approve every later ExecutionDirective.

The Supervisor receives delegated authority to derive execution instructions **within** the approved Final Plan boundary.

---

## 9. PlanningRun / FinalPlan / ExecutionRun Cardinality

The relationship is not hard-coded as one-to-one.

Conceptually:

```text
PlanningRun
    ↓
FinalPlan
    ↓
0..N ExecutionRuns
```

The normal path is:

```text
1 PlanningRun
→ 1 FinalPlan
→ 1 ExecutionRun
```

but the same immutable Final Plan may be executed again in a new workspace or after an explicitly abandoned execution.

Crash/resume does **not** create a new ExecutionRun.

A genuine restart/re-execution does.

Each ExecutionRun permanently binds an exact FinalPlan revision.

It may never be rebound in place to a newer FinalPlan.

---

## 10. Execution Baselines

ExecutionRun distinguishes planning-time evidence from execution-time reality.

Conceptually:

```text
planningBaseline
    = repository/evidence state used when FinalPlan was approved

executionStartBaseline
    = actual workspace state observed when this ExecutionRun begins
```

The Final Plan's planning evidence explains why the design was approved.

The execution baseline explains what physical state execution actually started from.

Expected execution edits do not retroactively invalidate the completed Final Plan's planning evidence snapshot.

---

## 11. ExecutionRun State Model

ExecutionRun is the authoritative execution lifecycle object.

The lifecycle is intentionally small:

```text
prepared
   ↓
active
   ├────────────→ completed
   ├────────────→ replan_required
   └────────────→ aborted
```

Conceptually:

```ts
interface ExecutionRun {
  id: ExecutionRunID
  workspaceIdentity: WorkspaceIdentity
  finalPlan: FinalPlanRef

  lifecycle:
    | "prepared"
    | "active"
    | "completed"
    | "replan_required"
    | "aborted"

  planningBaseline: PlanningSnapshotRef
  executionStartBaseline: RepositoryStateRef

  acceptedHead: ExecutionCommitRef
  activeStage?: ExecutionStageRef
  openWindow?: VerificationWindowRef

  revision: number

  createdAt: Timestamp
  updatedAt: Timestamp
}
```

Ordinary implementation failure, verification failure, blocking, or temporary environment problems do not become ExecutionRun lifecycle states.

They belong to lower-level work artifacts.

`completed`, `replan_required`, and `aborted` are terminal.

---

## 12. Accepted Execution State

ExecutionRun maintains a distinction between:

```text
acceptedHead
```

and:

```text
current mutable workspace
```

The workspace may contain changes that have not yet been independently verified or accepted.

Only `ExecutionCommit` advances `acceptedHead`.

A failed or blocked Directive does not implicitly roll back the workspace.

Rollback, cleanup, or repair must be explicit work.

---

## 13. ExecutionStage

### 13.1 Purpose

`ExecutionStage` is a durable execution-decomposition object.

It organizes Final Plan implementation obligations into manageable work phases.

It is not a Plan Section and it does not create normative design authority.

### 13.2 Derivation

Initial stages may be derived from FinalPlan implementation order and dependencies.

During execution, the Supervisor may refine the decomposition by:

```text
splitting a Stage
merging adjacent non-conflicting Stages
refining Stage objectives
adjusting non-mandatory order
```

provided no approved dependency or normative meaning changes.

### 13.3 State

Stage state is intentionally small:

```text
pending
active
completed
superseded
```

Rework, verification failure, blocked work, or failed attempts do not make a Stage `failed`.

A Stage remains `active` until its completion obligations are accepted.

### 13.4 No parallel active Stage

v0.2.0 explicitly does **not** support parallel active Stages.

Each ExecutionRun has at most:

```text
1 active Stage
1 open VerificationWindow
1 active logical Worker Attempt
```

FinalPlan dependencies may form a DAG, but execution is serialized in v0.2.0.

The Supervisor may choose among currently eligible stages when ordering is normatively equivalent.

Parallel branch/merge execution graphs are deferred to a future architecture version.

---

## 14. VerificationWindow

### 14.1 Definition

A `VerificationWindow` is a durable runtime object representing the unaccepted candidate span between two accepted ExecutionCommits.

Conceptually:

```text
EC-010
   ↓
WINDOW-011
   ├─ DIR-I11
   ├─ DIR-I12
   ├─ DIR-I13
   ├─ DIR-V14
   ├─ DIR-I15 rework
   └─ DIR-V16
   ↓
EC-011
```

The Window remains open through implementation, verification failure, rework, and re-verification until the candidate is accepted or the run terminates.

### 14.2 Candidate revision

Each Window has a monotonically increasing `candidateRevision`.

Any candidate-mutating implementation work advances the revision.

Verification and SupervisorAssessment must bind the exact:

```text
WindowID + candidateRevision
```

If the candidate later changes, prior verification and assessment can no longer close the new candidate state.

This is a deterministic staleness rule.

### 14.3 Window boundary

The Window boundary is:

```text
ExecutionCommit → ExecutionCommit
```

not:

```text
Verifier invocation → Verifier invocation
```

One Window may contain multiple implementation and verification attempts.

---

## 15. ExecutionDirective

### 15.1 Definition

An `ExecutionDirective` is a bounded execution authorization issued under an active ExecutionRun.

It is not a casual prompt.

It is an immutable, versioned, auditable work instruction derived from the exact FinalPlan and current execution state.

Authority ordering is:

```text
FinalPlan
    >
ExecutionDirective
    >
Worker local implementation choice
```

If a Directive conflicts with the Final Plan, the Directive is invalid.

A newer Directive never silently overrides approved design.

### 15.2 Directive kinds

v0.2.0 uses the same Directive protocol for:

```text
implementation
inspection
verification
```

No separate verifier-specific directive protocol exists.

### 15.3 Structured envelope + detailed body

A Directive contains a structured authority envelope plus a detailed instruction body.

Conceptually:

```ts
interface ExecutionDirective {
  id: DirectiveID
  revision: number
  hash: string

  executionRun: ExecutionRunRef
  finalPlan: FinalPlanRef
  stage: ExecutionStageRef
  window: VerificationWindowRef

  kind:
    | "implementation"
    | "inspection"
    | "verification"

  baseExecutionCommit: ExecutionCommitRef
  baseCandidateRevision: number

  objective: string

  planRefs: PlanMemoryRef[]
  expectedExecutionScope: ExecutionScope

  capabilityEnvelope: ExecutionCapabilityEnvelope

  invariants: DirectiveInvariant[]
  requiredActions: ActionRequirement[]
  forbiddenActions: ActionProhibition[]
  validationRequirements: ValidationRequirement[]
  deliverables: DeliverableRequirement[]
  stopConditions: StopCondition[]
  reportContract: ReportContract

  body: string
}
```

Exact field-level definitions are deferred to the Implementation SPEC.

---

## 16. Directive Immutability and Transaction Semantics

### 16.1 Issued Directive is immutable

Once a Directive revision is issued, its content never changes.

If the Supervisor must change instructions, scope, plan refs, capability envelope, or clarification text, it issues a new revision.

All Attempts and Reports bind exact:

```text
DirectiveID
DirectiveRevision
DirectiveHash
```

### 16.2 Logical transaction, not filesystem ACID

A Directive is a logical execution transaction boundary.

It is **not** an ACID transaction over the filesystem, processes, databases, networks, or external services.

Therefore:

```text
Worker side effects
    ≠
accepted execution progress
```

A failed or interrupted Directive does not imply automatic rollback.

### 16.3 No mid-attempt semantic mutation

The Supervisor does not inject new normative context into an already-running Attempt.

If a Worker needs clarification or additional Plan context, the current Attempt returns `blocked` and the Supervisor issues a new Directive revision.

This preserves the exact instruction package under which each Attempt ran.

---

## 17. ExecutionAttempt

`ExecutionAttempt` represents one logical Worker invocation under one exact Directive revision.

Top-level semantics are:

```text
1 issued Directive revision
→ 1 logical Attempt
```

Transport-level retries internal to the host do not constitute a new logical Attempt.

A side-effecting Attempt that becomes indeterminate is never blindly replayed under the same Directive revision.

Conceptually:

```ts
interface ExecutionAttempt {
  id: AttemptID
  directive: ExecutionDirectiveRef
  workerRole: "executor" | "verifier"

  state:
    | "running"
    | "reported"
    | "indeterminate"

  startedAt: Timestamp
  endedAt?: Timestamp
}
```

Exact transient/runtime fields are deferred.

---

## 18. ExecutionReport

### 18.1 Unified report schema

Executor and Verifier return the same `ExecutionReport` type.

There is no separate `VerificationReport` architecture object.

Conceptually:

```ts
interface ExecutionReport {
  id: ExecutionReportID
  attempt: ExecutionAttemptRef
  directive: ExecutionDirectiveRef
  workerRole: "executor" | "verifier"

  result:
    | "completed"
    | "partial"
    | "blocked"
    | "failed"

  actionsPerformed: string[]
  filesExamined: string[]
  filesChanged: string[]
  commandsRun: CommandSummary[]
  testsRun: TestSummary[]

  findings: Finding[]
  deviations: Deviation[]
  blockers: Blocker[]
  deliverables: DeliverableRef[]
}
```

### 18.2 Trust model in v0.2.0

v0.2.0 intentionally does **not** add a separate `ExecutionObservation` evidence layer.

Worker Reports are trusted as the execution facts they report.

This is an explicit architectural limitation, not an implicit assumption.

Future versions may insert Host-captured execution evidence beneath Reports without changing the Supervisor / Worker / Core authority relationship.

### 18.3 Report is not authoritative workflow state

Even though the Report is trusted as factual input:

```text
Executor says completed
    ≠ ExecutionCommit

Verifier says clean
    ≠ ExecutionCommit
```

Reports feed Supervisor reasoning; Core still owns authoritative progress transitions.

---

## 19. ExecutionWorker Abstraction

### 19.1 Common worker

Executor and Verifier are two roles of the same execution-worker abstraction.

Conceptually:

```text
ExecutionWorker
    ├─ role = executor
    └─ role = verifier
```

They share:

```text
host tool capabilities
Directive protocol
Attempt protocol
ExecutionReport schema
blocker protocol
```

Role does not itself grant additional tool authority.

### 19.2 Executor

The Executor performs implementation work and normal self-checks under Implementation Directives.

It may retain working conversational context across related implementation work for efficiency, but correctness must not depend on that conversational continuity.

Durable truth must be represented in Execution Memory.

### 19.3 Verifier

The Verifier is an independent execution-worker invocation used to inspect and verify a candidate state.

It is not a privileged validator and it does not possess stronger tool authority than the Executor.

Its independence comes from:

```text
fresh inference context
separate Worker invocation
no inherited Executor reasoning history
verification-specific Directive
```

Verifier is a role, not a persistent personality.

Each important verification should use a fresh Verifier invocation by default.

---

## 20. Supervisor Authority

The Execution Supervisor is a pure control-plane model.

Its role is:

```text
read
reason
direct
judge
```

It does not perform normal repository/runtime tool work directly.

The Supervisor may read:

```text
FinalPlan
exact referenced Plan Memory
ExecutionRun
ExecutionStages
VerificationWindows
ExecutionCommits
issued Directives
Attempts
ExecutionReports
SupervisorAssessments
ExecutionIssues
```

The Supervisor does not directly use normal host repository/runtime tools such as:

```text
file read / grep / glob
edit / write
shell
build
test
git operations
```

If it needs repository information, it issues an inspection or verification Directive to a Worker.

This prevents the frontier Supervisor from degrading into the main coding agent.

---

## 21. Supervisor / Worker Communication Boundary

Formal communication between Supervisor and Worker occurs only through durable execution artifacts:

```text
ExecutionDirective
ExecutionReport
```

Correctness must not depend on implicit shared chat history.

The Supervisor does not rely on “what the Executor said earlier in the conversation” unless it is represented in the durable Report / Execution Memory.

The Worker does not rely on hidden Supervisor reasoning.

---

## 22. Worker Plan Context

Workers do not receive unrestricted Plan Memory by default.

A Directive carries exact `planRefs` required for the work.

Worker context is normally:

```text
current Directive
exact referenced approved Plan artifacts
accepted execution-state summary
repository context discovered through tools
```

The Worker does not freely browse all Plan Memory merely to reconstruct design intent.

If the supplied normative context is insufficient, the Worker returns `blocked` rather than inventing or completing design.

---

## 23. Execution Capability Envelope

### 23.1 Purpose

Each Directive may include an `ExecutionCapabilityEnvelope` describing high-level categories of allowed side effects.

Conceptually:

```text
repositoryRead
repositoryWrite
commandExecution
networkAccess
dependencyMutation
gitCommit
gitPush
externalServiceMutation
```

Exact fields are deferred.

### 23.2 Effective capability

Worker effective capability is bounded by:

```text
Host/User permission ceiling
        ∩
ExecutionRun policy ceiling
        ∩
Directive capability envelope
```

The Supervisor may narrow capability but cannot elevate beyond the host/user or ExecutionRun ceiling.

### 23.3 Capability is not semantic scope

Capability answers:

> **What classes of external actions may this Worker perform?**

It does not answer:

> **What design meaning may this Worker change?**

Semantic constraints remain in the Directive and Final Plan and are enforced through Worker compliance plus Supervisor judgment.

### 23.4 No path-level hard enforcement in v0.2.0

Phase Plan v0.2.0 does not use Supervisor-specified path allowlists as an architectural execution boundary.

Supervisor-provided file paths, symbols, and expected files are execution guidance, not authoritative path permissions.

The host's own sandbox/permission system remains authoritative where applicable.

---

## 24. Expected Execution Scope and Semantic-Preserving Correction

Supervisor repository assumptions are descriptive, not normative, unless explicitly rooted in approved design.

The Directive may state an expected execution scope such as:

```text
expected files
expected symbols
expected call path
expected tests
```

If the real repository differs, the Executor may adapt without returning to the Supervisor when the correction preserves the exact normative meaning.

Allowed examples include:

```text
file moved or renamed
symbol renamed
implementation split across supporting files
private helper extraction
actual test location differs
local imports/types/fixtures require corresponding edits
existing equivalent utility should be reused
```

The Executor records such deviations in its Report.

The governing test is:

```text
Can the Worker adapt the Directive to actual repository structure
while preserving exactly the same normative meaning?

YES → continue + report deviation
NO / UNCERTAIN → block
```

This is called **semantic-preserving correction authority**.

---

## 25. Worker Local Implementation Freedom

Workers may decide non-normative local implementation details such as:

```text
local variable names
private helper decomposition
equivalent language syntax
mechanical imports
formatting
test fixture construction
temporary diagnostic commands
reuse of equivalent local utility
```

Workers may not independently choose among materially different normative outcomes involving areas such as:

```text
public behavior
cross-component contracts
persistent data semantics
state-machine semantics
failure / recovery semantics
architectural ownership
dependency direction
security / permission boundaries
compatibility / lifecycle commitments
approved interfaces / constraints / invariants
```

---

## 26. Blocked Work Protocol

### 26.1 Blocked is a normal result

`blocked` is a first-class ExecutionReport result.

It means:

> **The Worker cannot safely continue without exceeding the authority of the current Directive or without missing required execution conditions.**

It is not equivalent to an implementation failure.

### 26.2 Blocker classes

The architecture recognizes at least the following conceptual blocker categories:

```text
MISSING_CONTEXT
AMBIGUOUS_DIRECTIVE
REPOSITORY_MISMATCH
UNEXPECTED_SCOPE
CONFLICTING_REQUIREMENTS
MISSING_PREREQUISITE
EXECUTION_ENVIRONMENT_BLOCKER
```

Exact enum names and payload schema are deferred.

### 26.3 No mid-attempt clarification RPC

A blocked Worker does not receive hidden mid-attempt semantic updates.

The Supervisor resolves the issue by issuing a new Directive revision or a new Directive after reading the Report.

---

## 27. Repository Discovery vs Design Completion

Workers may perform repository reality discovery, including:

```text
locating symbols
finding current function signatures
identifying existing tests
following call paths
identifying existing helpers
finding actual build/test commands
mapping renamed or moved implementation structures
```

Workers may not perform design completion when multiple materially different normative choices remain.

Therefore:

```text
repository adaptation
    = Worker authority

normative adaptation
    = not Worker authority
```

---

## 28. Supervisor as JIT Execution Compiler

The Supervisor is defined as:

> **A JIT compiler from immutable FinalPlan obligations plus current execution state into concrete ExecutionDirectives.**

It may:

```text
expand approved obligations
combine approved facts
logically derive execution consequences
select among normatively equivalent implementation realizations
sequence work within approved dependency constraints
respond to Worker blockers
refine Stage / Window decomposition
```

It may not:

```text
create new normative design facts
change approved constraints
silently amend interfaces/contracts
choose among materially different normative designs
turn repository legacy behavior into new plan authority
```

---

## 29. Supervisor Derivation Rule

For an execution question, let:

```text
P = approved FinalPlan + exact approved refs
R = current repository reality known through Worker reports
S = LegalSolutions(P, R)
```

Each feasible solution has a normative projection:

```text
N(s)
```

The Supervisor may continue execution when:

```text
| { N(s) | s ∈ S } | == 1
```

That means either:

- only one legal execution solution remains; or
- multiple technical implementations remain, but all are normatively equivalent.

If:

```text
| { N(s) | s ∈ S } | > 1
```

and the Final Plan does not choose among them, the plan is under-specified for execution and `REPLAN_REQUIRED` applies.

---

## 30. Normative Projection

A normative projection is the design-level commitment implied by an implementation choice.

Relevant normative surfaces include at least:

```text
externally observable behavior
public or cross-component contracts
persistent data semantics
state-machine semantics
failure / recovery semantics
architectural ownership / dependency direction
security / permission boundaries
compatibility / lifecycle commitments
explicit approved constraints and invariants
other properties explicitly elevated to requirements by FinalPlan
```

The architecture uses two practical tests.

### 30.1 Amendment Test

Ask:

> **If the system were already implemented using solution A, would changing from A to B require a Plan amendment?**

If no, the difference is normally an execution detail.

If yes, A and B are materially different normative choices.

### 30.2 Downstream Dependency Test

Ask:

> **Must downstream work treat the A/B distinction as a design contract rather than merely discovering the current repository implementation?**

If yes, the difference is likely normative.

---

## 31. Operational Gap vs Design Gap

The Supervisor may fill an **operational gap**:

```text
FinalPlan already determines what the system must be,
but the concrete next repository action is unspecified.
```

The Supervisor may not fill a **design gap**:

```text
FinalPlan does not determine which materially different normative behavior the system should have.
```

Therefore:

```text
missing implementation detail
    ≠
missing design obligation
```

Only the latter can force replanning.

Best practice, industry convention, aesthetic preference, or model preference does not grant the Supervisor authority to choose an unapproved normative option.

---

## 32. Repository Reality and Plan Authority

Repository reality may eliminate technically impossible or architecturally illegal options and therefore reduce the legal solution set.

It may not override the Final Plan.

If the repository contains legacy behavior that conflicts with approved design:

```text
FinalPlan wins
```

provided the approved design remains implementable.

If repository reality proves a critical approved assumption false and no semantic-preserving realization remains, execution must replan.

---

## 33. REPLAN_REQUIRED

### 33.1 Core definition

`REPLAN_REQUIRED` means:

> **The current immutable FinalPlan no longer provides a legal and sufficiently defined path for continuing execution without introducing a new normative decision or changing an approved normative fact.**

It is not a synonym for:

```text
implementation is hard
many files changed
first attempt failed
tests failed
Verifier found a bug
Supervisor guessed a path incorrectly
work exceeded estimated effort
```

### 33.2 Typical mandatory triggers

Replanning is required when continuing would require changing or newly deciding areas such as:

```text
hard constraint
invariant
approved interface
SectionContract
approved Decision
explicit dependency semantics
architectural ownership
persistent data semantics
state-machine behavior
failure / recovery semantics
security / permission boundary
compatibility commitment
critical repository assumption with no preserving mapping
missing design obligation that blocks implementation
normative contradiction between approved requirements
```

### 33.3 Worker cannot trigger authoritative replan

Executor and Verifier may only return `blocked` and explain the issue.

The Supervisor performs the semantic derivation test.

The Supervisor may request replanning, but Core performs the authoritative lifecycle transition.

### 33.4 Terminal semantics

`ExecutionRun.lifecycle = replan_required` is terminal.

The ExecutionRun remains permanently bound to its original FinalPlan.

A new or amended FinalPlan always produces a new ExecutionRun.

The old run is never rebound in place.

### 33.5 ExecutionIssue transaction

Transition to `replan_required` must atomically persist a durable `ExecutionIssue` describing:

```text
reason
affected normative refs
relevant Worker Reports
accepted execution history
current execution context
```

The new PlanningRun uses this issue as formal input and reopens only the affected normative scope by default.

Prior execution history becomes planning context, not automatically approved Plan Memory.

---

## 34. Verifier Insertion Policy

### 34.1 Verification is not per-Directive

Independent verification is not inserted after every ImplementationDirective.

Instead, multiple implementation Directives may accumulate within one VerificationWindow.

The pattern is:

```text
continuous implementation + self-check
        ↓
periodic independent verification
```

not:

```text
implementation → verifier → implementation → verifier → ...
```

### 34.2 Executor self-check

Each ImplementationDirective may require normal self-checks such as:

```text
focused tests
build / typecheck / lint
local inspection
self-consistency checks
```

These are not independent verification.

### 34.3 Mandatory independent verification gates

Fresh independent verification is required before:

```text
any ExecutionCommit
crossing an important dependency / stage boundary where downstream work relies on the candidate
Stage completion
ExecutionRun completion
```

Critical changes may additionally require immediate verification before further implementation is layered on top.

### 34.4 Immediate vs batchable

A Directive may carry a verification requirement conceptually equivalent to:

```text
immediate
batchable
```

`immediate` means normal implementation progression pauses until independent verification closes the candidate.

`batchable` allows tightly related work to accumulate in the current Window.

The Supervisor may upgrade batchable work to immediate verification based on runtime uncertainty.

Mandatory verification requirements may not be silently downgraded.

### 34.5 Maximum unverified span

The implementation must provide a bounded maximum unverified span to prevent indefinite accumulation of unverified work.

The exact limit is an Implementation SPEC policy, not a v0.2.0 architecture constant.

### 34.6 Verify candidate state, not action replay

Verifier validates the final candidate state and relevant obligations of the Window.

It does not need to replay every intermediate implementation action.

---

## 35. Verifier Context and Independence

Verifier uses a fresh inference context by default.

It receives:

```text
VerificationDirective
ImplementationDirective(s) being verified
exact required FinalPlan refs
accepted execution baseline/context needed by the Directive
normal repository tool access through the Worker runtime
```

It does not inherit:

```text
Executor raw conversation
Executor reasoning history
Executor temporary assumptions
```

The Executor's raw Report is not injected into the Verifier by default unless the VerificationDirective intentionally requires it.

The Supervisor may compile relevant concerns from the Executor Report into the VerificationDirective.

This reduces anchoring while preserving focused verification.

---

## 36. Verifier Behavior

Verifier and Executor have the same technical worker capabilities.

The active Directive determines current authority.

A VerificationDirective normally authorizes inspection/testing, not corrective implementation.

If the Verifier finds an implementation defect, it reports the defect and stops according to the Directive.

It does not silently repair the candidate and then verify its own repair.

Corrective work occurs under a later ImplementationDirective executed by an Executor role.

After any candidate-mutating rework, prior verification of an older candidate revision cannot close the new candidate.

---

## 37. Executor / Verifier Report Conflicts

### 37.1 Negative-result dominance for acceptance

Any unresolved acceptance-relevant negative result prevents ExecutionCommit.

The protocol does not decide that “Executor wins” or “Verifier wins.”

Examples:

```text
Executor: complete
Verifier: blocking defect
    → candidate not accepted

Executor: failed
Verifier: looks clean
    → candidate not accepted
```

This is gate precedence, not factual authority precedence.

### 37.2 Ordinary verifier defect finding

If Executor reports success and Verifier identifies a concrete blocking defect, the normal response is:

```text
no ExecutionCommit
→ Supervisor issues rework ImplementationDirective
→ Executor repairs
→ fresh verification
```

No extra “judge model” is required.

### 37.3 True factual contradiction

A dedicated conflict-resolution verification is used only when trusted reports make mutually exclusive claims about an acceptance-relevant fact and that fact must be resolved before the next action.

The Supervisor issues a narrow VerificationDirective focused on the disputed fact.

The fresh conflict-resolution Verifier should be blinded to worker identities where practical.

It determines the fact rather than voting on agents.

### 37.4 No majority voting

Phase Plan does not use model majority voting as factual authority.

Multiple similar model outputs may share systematic errors.

### 37.5 Bounded conflict recursion

Automatic conflict resolution may add at most one dedicated fresh conflict-resolution Verifier beyond the original verification dispute.

If the contradiction remains materially unresolved, the candidate enters a `verification_blocked` execution condition and cannot be committed.

The Supervisor must then choose among:

```text
further execution-level inspection/rework
environment correction
user input
REPLAN_REQUIRED when normative authority is insufficient
```

The system does not launch unlimited verifier recursion.

---

## 38. Verification Coverage and SupervisorAssessment

A Verifier PASS does not automatically authorize acceptance.

The Supervisor evaluates whether the current verification coverage is sufficient to close the relevant execution obligations.

VerificationDirective should identify the obligations it intends to close.

The Supervisor may request additional verification only when justified by:

```text
uncovered required obligation
new material finding
unresolved conflict
candidate mutation invalidating prior verification
```

It must not create unbounded “verify again for confidence” loops without a concrete uncovered reason.

---

## 39. SupervisorAssessment

`SupervisorAssessment` is an immutable semantic judgment over an exact Window candidate.

Conceptually:

```ts
interface SupervisorAssessment {
  id: SupervisorAssessmentID
  executionRun: ExecutionRunRef
  window: VerificationWindowRef
  candidateRevision: number

  implementationReports: ExecutionReportRef[]
  verificationReports: ExecutionReportRef[]

  planRefs: PlanMemoryRef[]
  coveredObligations: ObligationRef[]

  disposition:
    | "accept"
    | "rework"
    | "need_more_verification"
    | "blocked"
    | "request_replan"

  rationale: string
}
```

The Supervisor cannot directly create an ExecutionCommit or advance acceptedHead.

It submits the assessment; Core validates protocol/state invariants and performs the authoritative transition.

If the candidateRevision changes after assessment, that assessment cannot close the newer candidate.

---

## 40. ExecutionCommit

### 40.1 Purpose

`ExecutionCommit` is the only object that advances authoritative accepted execution progress.

It is append-only and forms a linear chain in v0.2.0:

```text
EC-000
   ↓
EC-001
   ↓
EC-002
   ↓
EC-003
```

It is not a Git commit.

### 40.2 Commit bundle

A commit may aggregate multiple Directives and Reports from one VerificationWindow.

Conceptually:

```ts
interface ExecutionCommit {
  id: ExecutionCommitID
  parent: ExecutionCommitRef

  executionRun: ExecutionRunRef
  stage: ExecutionStageRef
  window: VerificationWindowRef
  candidateRevision: number

  directiveRefs: ExecutionDirectiveRef[]
  reportRefs: ExecutionReportRef[]
  supervisorAssessment: SupervisorAssessmentRef

  satisfiedObligations: ObligationRef[]
  resultingRepositoryState?: RepositoryStateRef

  createdAt: Timestamp
}
```

Exact fields are deferred.

### 40.3 Commit gate

Core may create ExecutionCommit only when:

```text
ExecutionRun is active
Window and candidateRevision are exact/current
required verification exists for the candidate
SupervisorAssessment == accept
no unresolved blocking verification result exists
no stale acceptedHead/base exists
Stage/dependency invariants are satisfied
```

The exact deterministic gate is an Implementation SPEC item, but these semantic conditions are architectural requirements.

---

## 41. Stage Completion

A Stage may span multiple VerificationWindows and ExecutionCommits.

Example:

```text
STAGE-02

WINDOW-A → EC-011
WINDOW-B → EC-012
WINDOW-C → EC-013
                    ↓
              Stage completed
```

A Stage becomes completed only when a successful ExecutionCommit closes all Stage completion obligations.

The Supervisor cannot directly set `Stage.completed`.

Stage completion is Core-derived from accepted execution state.

Stage activation is also Core-gated by dependency/order constraints.

---

## 42. ExecutionRun Completion

Completion of the last ordinary Stage does not automatically complete the ExecutionRun.

v0.2.0 requires an execution-level final closure gate.

Conceptually:

```text
all required Stages completed
        ↓
Final Verification Window
        ↓
fresh Verifier
        ↓
SupervisorAssessment = accept
        ↓
Final ExecutionCommit
        ↓
ExecutionCompletionGate
        ↓
ExecutionRun.completed
```

The final closure ensures cross-Stage integration obligations are checked rather than assuming local Stage success implies global correctness.

Simple tasks may use only one Stage and one Window before final closure.

---

## 43. Recovery and Session Ownership

### 43.1 Durable execution vs conversation session

ExecutionRun is durable execution authority.

The Claude conversation/session is a replaceable runtime attachment.

Therefore:

```text
session close
session crash
conversation compaction
/clear
```

do not automatically abort or complete an ExecutionRun.

### 43.2 SupervisorBinding

Attachment is modeled separately from ExecutionRun lifecycle.

Conceptually:

```text
ExecutionRun.lifecycle = active
SupervisorBinding = attached | detached
```

`detached` is not an ExecutionRun lifecycle state.

### 43.3 Single writable Supervisor owner

One active ExecutionRun may have at most one writable Supervisor session owner.

Ownership uses monotonically increasing generation/fencing semantics.

Example:

```text
session S1 generation = 5
        ↓
explicit resume/takeover
        ↓
session S2 generation = 6
```

Any later mutation from generation 5 is rejected.

### 43.4 Workers do not own Run binding

Executor and Verifier are ephemeral Worker invocations associated with an Attempt.

They do not own long-lived writable ExecutionRun bindings.

---

## 44. Crash Semantics

### 44.1 Durable Report before acknowledgement

If Worker execution completes, the Report must be durably persisted before the run is considered reported.

A crash after durable persistence but before UI acknowledgement must not cause the same logical Attempt to run again.

### 44.2 Indeterminate Attempt

If a side-effecting Worker Attempt is interrupted without a durable Report, the Attempt becomes `indeterminate`.

The system does not assume success or failure.

The same Directive revision is not automatically replayed.

Recovery proceeds through a new inspection/reconciliation Directive to re-establish current repository reality.

### 44.3 Verification interruption

An interrupted verification Attempt without a durable Report cannot be used as verification coverage.

The Supervisor later issues a fresh VerificationDirective.

### 44.4 Supervisor disconnect while Worker runs

If a Worker Attempt was validly launched under a durable immutable Directive, temporary Supervisor-session disconnection does not automatically cancel the Worker.

The Worker may finish and persist its Report.

The Report waits for a Supervisor to reattach and continue reasoning.

### 44.5 Authoritative runtime loss

If the Harness/runtime cannot maintain authoritative Attempt identity or persistence, supervised execution must not transparently continue.

Uncertain work is recovered as indeterminate.

Exact child-process cleanup behavior belongs to the adapter/Implementation SPEC.

---

## 45. `/clear`, Fork, Rewind, and Compaction

Conversation operations do not rewrite Execution Memory.

### `/clear`

Creates a new conversation context but does not silently transfer writable ExecutionRun ownership.

The previous binding becomes detached; a new session must explicitly resume/take over.

### Fork

Forked conversations do not inherit writable ExecutionRun ownership by default.

### Rewind/checkpoint rollback

Conversation rewind does not rewind:

```text
ExecutionDirective
ExecutionReport
SupervisorAssessment
ExecutionCommit
ExecutionRun lifecycle
```

### Compaction

Conversation compaction cannot remove canonical execution truth.

Recovery context must be reconstructed from the Store.

---

## 46. Execution Recovery Context

The adapter may render a compact recovery projection such as:

```text
Execution Recovery Context

FinalPlan: FINAL-07
ExecutionRun: EXEC-03
acceptedHead: EC-12
activeStage: STAGE-04
openWindow: WIN-13 / candidateRevision=2
latest work:
  DIR-I18 → REP-I18 completed
  DIR-V19 → REP-V19 blocking defect
next semantic state:
  awaiting Supervisor decision
```

This capsule is a reasoning aid only.

It is not canonical authority.

If a recovery capsule conflicts with canonical stored objects, the Store wins.

---

## 47. Abort Semantics

`aborted` is a terminal ExecutionRun lifecycle state.

Abort requires explicit human authorization.

The Supervisor may request or recommend abort but cannot authoritatively abort the run on its own.

Abort preserves:

```text
FinalPlan binding
Stages
Windows
Directives
Attempts
Reports
SupervisorAssessments
ExecutionCommits
ExecutionIssues
audit history
```

Abort does not automatically roll back workspace modifications.

```text
abort execution protocol
    ≠
undo repository state
```

Any rollback must be explicit execution or user action.

---

## 48. Workspace Identity and Migration

ExecutionRun binds a stable `WorkspaceIdentity`.

Worktrees of the same repository are distinct execution workspaces.

v0.2.0 does not automatically migrate an active ExecutionRun to another worktree/workspace.

If the bound workspace disappears:

```text
ExecutionRun remains durable
repository-dependent operations fail closed
```

Execution history is not deleted.

---

## 49. Storage Scope

v0.2.0 continues the v0.1 local persistent storage model.

Canonical durable state belongs in the Phase Plan Store under the plugin data domain, not in conversation history or repository Markdown.

The Store persists execution objects in addition to planning objects.

Conceptually, durable execution storage includes:

```text
ExecutionRuns
ExecutionStages
VerificationWindows
ExecutionDirectives
ExecutionAttempts
ExecutionReports
SupervisorAssessments
ExecutionCommits
ExecutionIssues
SupervisorBindings
append-only audit events
```

v0.2.0 continues to assume local single-machine storage scope.

Transparent cross-machine continuation and shared multi-machine SQLite are out of scope.

Exact SQL DDL, indexes, migrations, PRAGMAs, backup policy, and retention policy belong to the Implementation SPEC.

---

## 50. Model-Facing Execution API Principles

The model-facing API remains domain-oriented.

Models do not receive CRUD primitives or direct state setters.

Conceptual Supervisor-facing capabilities may include operations equivalent to:

```text
get_execution_state
read_execution_context
issue_execution_directive
submit_supervisor_assessment
request_stage_activation
request_replan
request_abort
resume/takeover execution run
```

Conceptual Worker-facing capabilities may include:

```text
get_active_directive
read_allowed_plan_context
submit_execution_report
```

Exact API names and MCP JSON Schemas are deferred.

Internal-only primitives remain non-model-facing, including concepts equivalent to:

```text
set_execution_lifecycle
set_stage_state
set_active_stage
set_open_window
advance_candidate_revision
append_execution_commit
set_accepted_head
set_binding_generation
write_execution_database
force_execution_complete
force_replan
```

Models request business actions; Core owns end-state mutation.

---

## 51. Error Semantics

v0.2.0 should expose stable machine-readable execution error categories.

The exact list is deferred, but architecture-level classes include errors equivalent to:

```text
STALE_EXECUTION_HEAD
STALE_CANDIDATE_REVISION
STALE_SUPERVISOR_BINDING
INVALID_EXECUTION_LIFECYCLE
INVALID_STAGE_TRANSITION
DIRECTIVE_NOT_CURRENT
DIRECTIVE_HASH_MISMATCH
ATTEMPT_ALREADY_CONSUMED
CAPABILITY_NOT_AVAILABLE
WINDOW_NOT_OPEN
VERIFICATION_REQUIRED
VERIFICATION_STALE
BLOCKING_VERIFICATION_RESULT
REPLAN_REQUIRED
WORKSPACE_UNAVAILABLE
STORE_SCHEMA_MISMATCH
```

Agents must recover from stable error codes rather than natural-language parsing.

---

## 52. Core Invariants

v0.2.0 freezes the following execution invariants in addition to the unchanged v0.1 planning invariants.

### Plan / execution boundary

1. Execution is not a PlanningRun stage.
2. PlanningRun and ExecutionRun are separate durable lifecycle objects.
3. FinalPlan is the normative bridge between planning and execution.
4. Each ExecutionRun permanently binds one exact immutable FinalPlan revision.
5. An ExecutionRun never rebinds in place to a newer FinalPlan.
6. Completed PlanningRuns are never reactivated.
7. Final Approval authorizes supervised execution under the exact FinalPlan but does not bypass host permissions.

### Execution authority

8. Claude Code owns execution mechanics; Phase Plan owns supervised-execution protocol truth.
9. Supervisor reasons and directs; Workers perform repository/runtime actions; Core performs authoritative transitions.
10. Supervisor has no normal direct repository/runtime tool authority.
11. Executor and Verifier are roles of the same ExecutionWorker abstraction.
12. Executor/Verifier Reports are trusted factual inputs in v0.2.0, but Reports do not themselves advance authoritative execution state.
13. ExecutionObservation is not part of v0.2.0.

### Directive semantics

14. Issued Directive revisions are immutable.
15. Directive authority is lower than FinalPlan authority.
16. Directive mutation requires a new revision.
17. One Directive revision maps to one logical Attempt.
18. Mid-attempt semantic instruction mutation is forbidden.
19. A Directive is a logical execution transaction, not a filesystem ACID transaction.
20. Worker side effects do not imply accepted progress.

### Worker freedom and boundaries

21. Workers may perform repository discovery and semantic-preserving correction.
22. Supervisor path/file expectations are guidance, not Phase Plan hard path permissions.
23. Workers may choose non-normative local implementation details.
24. Workers may not fill normative/design gaps.
25. Missing normative context causes `blocked`, not silent design completion.
26. Workers receive exact Directive-scoped Plan context by default, not unrestricted Plan Memory.

### Verification

27. Independent Verifier is not inserted after every ImplementationDirective.
28. Verification is organized around VerificationWindows and acceptance boundaries.
29. Executor self-check does not count as independent verification.
30. Every ExecutionCommit requires fresh independent verification covering the exact current candidate.
31. Candidate mutation invalidates verification/assessment bound to older candidate revisions.
32. Verifier uses a fresh inference context by default and does not inherit Executor reasoning history.
33. Verifier does not silently repair implementation defects during verification.
34. Acceptance-relevant negative or contradictory reports block ExecutionCommit until resolved.
35. Model majority voting is not a factual authority mechanism.
36. Conflict-resolution verifier recursion is bounded.

### Supervisor derivation / replanning

37. Supervisor is a JIT compiler from approved normative state to concrete execution instructions.
38. Supervisor may derive execution consequences but may not create new normative design facts.
39. Supervisor may choose among normatively equivalent legal realizations.
40. Multiple materially different normative projections without an approved choice require replanning.
41. Best practice or model preference does not authorize unapproved normative choice.
42. Repository reality may narrow implementation options but cannot rewrite FinalPlan authority.
43. `REPLAN_REQUIRED` is terminal for the current ExecutionRun.
44. Replanning creates a new PlanningRun and later a new ExecutionRun.
45. Transition to `replan_required` atomically records an ExecutionIssue.

### Execution progress

46. `ExecutionCommit` is the only object that advances `acceptedHead`.
47. ExecutionCommit chain is linear in v0.2.0.
48. A VerificationWindow represents the unaccepted span between accepted ExecutionCommits.
49. Window candidateRevision is monotonic.
50. Stage completion is Core-derived from accepted execution progress.
51. ExecutionRun completion requires a final execution-level closure gate.
52. Mutable workspace state may differ from accepted execution state.

### Concurrency / recovery

53. v0.2.0 supports at most one active Stage per ExecutionRun.
54. v0.2.0 supports at most one open VerificationWindow per ExecutionRun.
55. v0.2.0 supports at most one active logical Worker Attempt per ExecutionRun.
56. One active ExecutionRun has at most one writable Supervisor session owner.
57. Supervisor ownership uses generation/fencing semantics.
58. Worker invocations do not own long-lived ExecutionRun bindings.
59. Session close, crash, compaction, `/clear`, fork, or rewind do not rewrite durable execution history.
60. Side-effecting Attempt interruption without durable Report becomes indeterminate and is not blindly replayed.
61. Report persistence precedes successful Attempt acknowledgement.
62. Recovery is reconstructed from canonical Execution Memory, not conversation summary.
63. Abort is explicit human-authorized termination and does not imply workspace rollback.
64. ExecutionRun binds stable WorkspaceIdentity and does not auto-migrate across worktrees.

---

## 53. Frozen v0.2.0 Non-Goals

v0.2.0 deliberately excludes:

```text
prompt-complexity task classification
separate simple/complex execution protocols
parallel active ExecutionStages
parallel open VerificationWindows
ExecutionCommit DAG / branch-merge execution history
multi-worker concurrent implementation orchestration
path-level hard enforcement from Supervisor path guesses
symbol-level hard write allowlists
ExecutionObservation / host-captured execution evidence layer
automatic filesystem rollback for failed/aborted work
unbounded verifier recursion
majority-vote factual adjudication
Supervisor direct coding as fallback
Verifier self-repair of implementation defects
transparent cross-workspace migration
transparent cross-machine execution continuation
execution-time mutation of committed Plan Memory
model-controlled force/bypass transitions
```

The existing v0.1 non-goals around custom repository crawlers, vector databases, conversation summary as canonical state, arbitrary model routing, and cross-machine shared SQLite remain unless separately amended.

---

## 54. Deferred Implementation-Specification Work

The following are intentionally not architecture-blocking decisions:

```text
exact SQLite DDL / indexes / schema migration
exact TypeScript interfaces and field optionality
MCP JSON Schemas and concrete tool names
canonical Directive / Report / Assessment serialization and hash format
exact ExecutionCapabilityEnvelope fields
exact blocker enum/payload schema
exact error-code list and payload schema
maximum unverified span numeric limits
Stage auto-generation heuristics
Verifier prompt text
Executor prompt text
Supervisor prompt text
Recovery Context rendering format
Worker runner implementation
child-process cancellation / timeout behavior
repository-state fingerprint implementation
exact detection of candidate mutation
exact host permission mapping
logging / trace format
backup / retention policy
CI and E2E test matrix
packaging / distribution details
future ExecutionObservation design
```

These may evolve without reopening v0.2.0 architecture provided they preserve the frozen invariants.

---

## 55. Recommended Implementation Order

A practical v0.2.0 implementation sequence is:

```text
1. Preserve v0.1 PlanningRun / Plan Memory / FinalPlan baseline
2. Add ExecutionRun persistence + FinalPlan binding + prepared/active handoff
3. Add SupervisorBinding + fencing + recovery context
4. Add ExecutionStage model + single-active-stage gate
5. Add VerificationWindow + candidateRevision
6. Add immutable ExecutionDirective model
7. Add ExecutionAttempt / unified ExecutionReport
8. Add Worker runner abstraction with executor/verifier roles
9. Add Supervisor-facing execution domain API
10. Add Worker-facing Directive/Report API
11. Add ExecutionCapabilityEnvelope plumbing
12. Add SupervisorAssessment
13. Add ExecutionCommit transaction + acceptedHead chain
14. Add Stage completion / activation gates
15. Add Verifier insertion policy + verification staleness
16. Add conflict-resolution verification path
17. Add blocker handling + Directive revision flow
18. Add REPLAN_REQUIRED + atomic ExecutionIssue
19. Add final execution closure gate
20. Add crash/interruption/indeterminate Attempt recovery
21. Add /clear/fork/takeover execution recovery tests
22. Add abort semantics
23. Add full v0.2.0 E2E exit-gate matrix
```

This order builds durable authority and recovery semantics before higher-level UX refinement.

---

## 56. v0.2.0 Exit Gate

The architecture is not considered implemented until the following end-to-end path works:

```text
user enters /phase-plan
    ↓
v0.1 planning lifecycle completes normally
    ↓
FinalPlan formally approved and committed
    ↓
PlanningRun = handoff_pending
    ↓
ExecutionRun created exactly once as prepared
    ↓
ExecutionRun becomes active
    ↓
PlanningRun completed
    ↓
first eligible Stage activated
    ↓
VerificationWindow opened
    ↓
Supervisor issues immutable ImplementationDirective
    ↓
Executor Attempt runs
    ↓
ExecutionReport durable
    ↓
additional implementation may accumulate in same Window
    ↓
Supervisor closes Window for verification
    ↓
fresh Verifier receives VerificationDirective
    ↓
Verifier Report durable
    ↓
SupervisorAssessment = accept
    ↓
Core creates ExecutionCommit
    ↓
acceptedHead advances
    ↓
next Window / Stage proceeds
    ↓
Stage completion derived from accepted obligations
    ↓
all required Stages complete
    ↓
final VerificationWindow
    ↓
final SupervisorAssessment
    ↓
final ExecutionCommit
    ↓
ExecutionCompletionGate passes
    ↓
ExecutionRun.completed
```

The implementation must additionally prove:

```text
multiple implementation Directives can share one VerificationWindow
candidate mutation invalidates prior verification
Verifier defect finding triggers rework without replanning
Executor/Verifier factual conflict uses one bounded conflict-resolution verifier
blocked Worker receives new immutable Directive rather than mid-attempt semantic injection
Supervisor path expectation may be corrected by Executor without hard-path failure
missing design obligation triggers REPLAN_REQUIRED
replan transition atomically records ExecutionIssue
new FinalPlan creates a new ExecutionRun rather than rebinding old run
session crash/resume restores active Stage/Window/acceptedHead
crash after durable Report does not replay Attempt
crash during side-effecting Attempt creates indeterminate state
indeterminate Attempt is reconciled through a new inspection Directive
/clear does not silently transfer writable Supervisor ownership
fork does not inherit writable ExecutionRun ownership
explicit takeover fences the old Supervisor generation
abort is terminal but does not rollback workspace
same FinalPlan may create a separate later ExecutionRun without modifying prior history
```

---

## 57. One-Sentence Definition

**Phase Plan v0.2.0 is a durable planning-and-execution harness that uses a frontier model to create and supervise an immutable user-approved Final Plan, delegates repository work to scoped execution-tier Workers through immutable Directives, independently verifies accepted execution windows, persists only Core-approved ExecutionCommits as authoritative progress, and returns to formal planning whenever correct continuation would require a new normative decision.**

---

## 58. Architecture Freeze

This document is the frozen Phase Plan v0.2.0 architecture baseline.

Changes that alter any of the following require an explicit architecture amendment:

```text
PlanningRun / ExecutionRun authority boundary
FinalPlan normative execution authority
Plan → Execution handoff semantics
ExecutionRun lifecycle
single-active-Stage / single-open-Window model
Supervisor read+direct authority boundary
Executor / Verifier common Worker abstraction
Directive immutability / transaction semantics
Worker local freedom vs normative decision boundary
Verifier insertion / conflict-resolution semantics
Supervisor derivation / normative projection rules
REPLAN_REQUIRED semantics
ExecutionCommit authority
acceptedHead semantics
Supervisor session ownership / fencing
Attempt crash / indeterminate semantics
abort semantics
workspace binding semantics
model-facing mutation boundaries
Core invariants listed in this specification
```

Implementation details listed in the deferred section may evolve without reopening the architecture, provided all frozen guarantees remain true.

---

# Appendix A — Reference Execution State Flow

```text
PlanningRun
    ↓ Final Approval + Final PlanCommit
handoff_pending
    ↓
ExecutionRun.prepared
    ↓
ExecutionRun.active
    ↓
STAGE-01.active
    ↓
WINDOW-01 rev0
    ↓
DIR-I01
    ↓
ATT-I01 / Executor
    ↓
REP-I01
    ↓ candidate rev1
DIR-I02
    ↓
ATT-I02 / Executor
    ↓
REP-I02
    ↓ candidate rev2
DIR-V03
    ↓
ATT-V03 / fresh Verifier
    ↓
REP-V03
    ↓
SupervisorAssessment
    ├─ rework
    │    ↓
    │  DIR-I04
    │    ↓
    │  candidate rev3
    │    ↓
    │  fresh verification
    │
    ├─ need_more_verification
    │    ↓
    │  DIR-Vxx
    │
    ├─ request_replan
    │    ↓
    │  ExecutionIssue + ExecutionRun.replan_required
    │
    └─ accept
         ↓
       Core gate
         ↓
       EC-01
         ↓
       acceptedHead = EC-01
         ↓
       Window closed
         ↓
       next Window / Stage
```

---

# Appendix B — Reference Replanning Flow

```text
Worker
    ↓
blocked Report
    ↓
Supervisor Derivation Test
    ↓
Can approved FinalPlan uniquely determine a legal continuation?
    ├─ yes → new Directive
    │
    └─ no
        ↓
Do all remaining legal solutions share one normative projection?
    ├─ yes → Supervisor selects execution realization
    │
    └─ no
        ↓
request_replan
        ↓
Core transaction:
    persist ExecutionIssue
    set ExecutionRun = replan_required
        ↓
new PlanningRun
        ↓
reopen affected normative scope
        ↓
new / reconfirmed FinalPlan
        ↓
new ExecutionRun
```

---

# Appendix C — Reference Conflict Flow

```text
Executor Report
    says factual claim A

Verifier Report
    says mutually exclusive factual claim B

        ↓
Supervisor determines contradiction is acceptance-relevant
        ↓
focused conflict-resolution VerificationDirective
        ↓
fresh Verifier
        ↓
Report
    ├─ resolves fact → continue
    └─ still indeterminate → verification_blocked
                              ↓
                     inspection / rework /
                     environment correction /
                     user input /
                     REPLAN_REQUIRED if normative authority is insufficient
```

No majority voting is used.

---

# Appendix D — Trust Model in v0.2.0

```text
Plan Memory
    trusted approved normative truth

ExecutionReport
    trusted Worker-reported factual input

SupervisorAssessment
    trusted semantic judgment request

Phase Plan Core
    deterministic workflow authority

ExecutionCommit
    authoritative accepted execution progress

Workspace
    mutable physical reality
```

`ExecutionObservation` is intentionally deferred to a later architecture revision.

