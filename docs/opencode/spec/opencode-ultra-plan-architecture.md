# Ultra Plan for OpenCode — Architecture Specification

**Status:** Frozen architecture baseline  
**Scope:** OpenCode implementation only  
**Harness entry point:** `/ultra-plan`

---

## 1. Purpose

Ultra Plan is a structured planning harness built on top of OpenCode.

It is not a replacement for OpenCode's session, agent, model, repository exploration, or execution runtime. OpenCode remains responsible for conversation/session management, model inference, repository tools, compaction, and execution.

Ultra Plan adds a deterministic planning workflow around OpenCode:

- use a frontier planning model while Ultra Plan is active;
- progressively design an architecture rather than producing a one-shot plan;
- require explicit user approval before design knowledge becomes committed;
- preserve approved design knowledge independently from conversation compaction;
- maintain provenance between repository observations and design decisions;
- detect conflicts, stale evidence, and invalidated dependencies;
- synthesize an immutable final plan from approved design state;
- automatically hand the same OpenCode session back to the execution agent/model only after final approval.

The fundamental boundary is:

> **OpenCode owns runtime and conversation. Ultra Plan owns planning workflow, committed planning state, approvals, context construction, and repository evidence.**

---

## 2. Top-Level Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                         OpenCode                             │
│                                                              │
│  conversation / session / agents / models / tools / compaction│
└──────────────────────────────┬───────────────────────────────┘
                               │
                        /ultra-plan
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                    Ultra Plan Harness                        │
│                                                              │
│  ┌────────────────┐     ┌────────────────────────────────┐  │
│  │   Controller   │────►│       State Machine            │  │
│  └───────┬────────┘     └────────────────────────────────┘  │
│          │                                                   │
│  ┌───────▼────────┐     ┌────────────────────────────────┐  │
│  │ Transaction    │────►│ Proposal → Approval → Commit   │  │
│  │ Engine         │     └────────────────────────────────┘  │
│  └───────┬────────┘                                         │
│          │                                                   │
│  ┌───────▼────────┐     ┌────────────────────────────────┐  │
│  │   Plan Memory  │◄───►│     Context Assembler          │  │
│  └───────┬────────┘     └───────────────┬────────────────┘  │
│          │                              │                   │
│  ┌───────▼──────────────┐    ┌──────────▼───────────────┐   │
│  │ Repository Evidence │    │ Planning Agent / Model   │   │
│  └──────────────────────┘    └──────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
                               │
                               ▼
                       same OpenCode session
                               │
                      final approval only
                               │
                               ▼
                         Build / Execute
```

Ultra Plan should use OpenCode-native mechanisms wherever possible rather than duplicating them.

---

## 3. Entry Point and Runtime Boundary

Ultra Plan registers its own command:

```text
/ultra-plan
```

It deliberately does not redefine `/plan`, avoiding conflicts with OpenCode or other mainstream planning conventions.

Starting `/ultra-plan` creates or resumes a `PlanningRun`, switches the current OpenCode session into the planning runtime configuration, and starts the planning state machine.

Conceptually:

```text
/ultra-plan
    │
    ├── create/resume PlanningRun
    ├── bind run to current OpenCode session
    ├── switch to planning agent/runtime
    ├── switch to configured planning model
    ├── activate Ultra Plan context
    └── enter DISCOVERY
```

A single OpenCode session may have at most one active `PlanningRun`.

Ultra Plan does not create a separate conversation for planning. Planning and execution remain in the same OpenCode session.

---

# 4. Planning State Machine

The state machine is intentionally separated from individual artifact status. This prevents combinatorial state explosion.

A `PlanningRun` contains:

```ts
interface PlanningRun {
  id: PlanID
  sessionID: string

  lifecycle:
    | "active"
    | "completed"
    | "aborted"

  stage:
    | "discovery"
    | "architecture"
    | "detail"
    | "synthesis"
    | "final"

  revision: number
  activeWork?: WorkRef

  goal: Goal
  constraints: Constraint[]

  architecture?: ArchitectureRef
  sections: SectionRef[]
  decisions: DecisionRef[]

  openQuestions: OpenQuestion[]
  conflicts: Conflict[]

  finalPlan?: FinalPlanRef

  headCommit?: CommitID
  headSnapshot?: SnapshotID

  createdAt: Timestamp
  updatedAt: Timestamp
}
```

Execution is intentionally not a planning stage. Once final handoff succeeds, the `PlanningRun` is complete and OpenCode resumes responsibility for execution.

## 4.1 Lifecycle

```text
IDLE
 │
 │ /ultra-plan
 ▼
DISCOVERY
 │
 ▼
ARCHITECTURE
 │
 │ architecture completion approval
 ▼
DETAIL
 │
 ├── section design
 │      │
 │      ├── checkpoint proposals
 │      ├── approvals
 │      └── commits
 │
 ├── section completion approval
 │
 └── next section
        │
        ▼
SYNTHESIS
 │
 ▼
VALIDATION
 │
 ├── conflict ─────────────► DETAIL / REOPEN
 │
 └── clean
        │
        ▼
      FINAL
        │
        │ explicit final approval
        ▼
 HANDOFF_PENDING
        │
        ▼
    COMPLETED
```

`handoff_pending` is recoverable. If OpenCode terminates after final approval but before the runtime has fully switched back to execution, Ultra Plan can safely resume the handoff.

---

# 5. Planning Artifacts

## 5.1 Constraints

Constraints describe conditions the design must satisfy.

```ts
interface Constraint {
  id: ConstraintID

  source:
    | "user"
    | "repository"
    | "environment"
    | "runtime"

  statement: string

  severity:
    | "hard"
    | "soft"

  status:
    | "active"
    | "superseded"
}
```

A hard constraint can block approval when a proposal violates it.

A constraint is different from a decision:

```text
Constraint:
Execution must continue in the same OpenCode session.

Decision:
Use OpenCode-native session model switching for handoff.
```

---

## 5.2 Decisions

Decisions are atomic units of durable design knowledge.

```ts
interface Decision {
  id: DecisionID
  revision: number

  title: string

  status:
    | "proposed"
    | "approved"
    | "superseded"

  statement: string
  rationale: string

  alternatives?: Alternative[]
  consequences?: string[]

  scope: {
    architecture?: boolean
    sections?: SectionID[]
  }

  evidence?: EvidenceRef[]
  supersedes?: DecisionRef
  approvedAt?: Timestamp
}
```

Approved decisions are immutable. Changing one creates a superseding revision through the normal proposal transaction.

---

## 5.3 Architecture

Architecture represents the approved top-level design snapshot.

```ts
interface Architecture {
  id: "ARCH"
  revision: number

  status:
    | "draft"
    | "awaiting_approval"
    | "approved"
    | "superseded"

  summary: string

  components: Component[]
  boundaries: Boundary[]
  dataFlows: DataFlow[]
  principles: Principle[]

  unresolved: OpenQuestion[]
  basedOn: DecisionID[]
}
```

Architecture and Decisions are deliberately separate:

- Architecture describes the system as a whole.
- Decisions explain durable choices that shape that architecture.

---

# 6. Section DAG

After the architecture is approved, the planning model decomposes it into a project-specific design graph.

Sections are not predefined categories.

Example:

```text
SEC-001 OpenCode Integration
   │
   ├────────► SEC-002 State Machine
   │
   └────────► SEC-004 Context Assembly
                    ▲
                    │
SEC-003 Plan Memory ┘
        │
        ▼
SEC-005 Approval Protocol
        │
        ▼
SEC-006 Recovery Semantics
        │
        ▼
SEC-007 Final Handoff
```

A section contains:

```ts
interface Section {
  id: SectionID
  title: string
  objective: string

  dependencies: SectionID[]

  status:
    | "pending"
    | "active"
    | "awaiting_approval"
    | "approved"
    | "reopened"

  validation:
    | "valid"
    | "needs_review"

  currentRevision?: number
  approvedRevision?: number
}
```

Users may discuss a section ahead of dependency order, but it cannot be committed as complete until required dependencies are approved.

---

## 6.1 Section Revisions

```ts
interface SectionRevision {
  sectionID: SectionID
  revision: number

  status:
    | "draft"
    | "awaiting_approval"
    | "approved"
    | "superseded"

  problem: string
  design: string

  interfaces: InterfaceSpec[]
  invariants: string[]
  failureModes: FailureMode[]
  dependencies: Dependency[]

  decisions: DecisionID[]
  openQuestions: OpenQuestionID[]
  impacts: SectionID[]

  projection: {
    compact: string
    contract: SectionContract
  }

  createdAt: Timestamp
}
```

Structured metadata and Markdown design prose coexist. Markdown is useful for human-readable design, but it is not the database.

---

## 6.2 Section Contracts

Every approved section produces an immutable contract projection.

```ts
interface SectionContract {
  sectionID: SectionID
  revision: number

  provides: string[]
  requires: string[]

  invariants: string[]
  interfaces: InterfaceRef[]
  decisions: DecisionRef[]
}
```

Downstream sections normally consume contracts rather than loading the full design of every dependency.

---

# 7. Open Questions and Conflicts

Open questions are first-class planning objects.

```ts
interface OpenQuestion {
  id: QuestionID

  question: string
  blocking: boolean

  scope:
    | ArchitectureRef
    | SectionRef

  status:
    | "open"
    | "resolved"

  resolution?: string
  resolvedBy?: DecisionID
}
```

Blocking questions prevent finalization.

Conflicts are also first-class:

```ts
interface Conflict {
  id: ConflictID

  type:
    | "decision"
    | "constraint"
    | "section"
    | "interface"

  refs: MemoryRef[]
  description: string

  severity:
    | "warning"
    | "blocking"

  status:
    | "open"
    | "resolved"

  resolution?: {
    action:
      | "revise_proposal"
      | "amend_decision"
      | "amend_architecture"

    ref: MemoryRef
  }
}
```

Blocking conflicts prevent finalization.

---

# 8. Reopening Approved Design

Approved design is never silently edited.

When later work reveals that an approved section or decision is wrong:

```text
detect conflict
     │
     ▼
identify affected artifact
     │
     ▼
reopen
     │
     ▼
create new revision
     │
     ▼
discuss
     │
     ▼
Proposal → Approval → Commit
```

Dependents of a changed artifact are not deleted. They transition to:

```text
validation = needs_review
```

They must be reviewed against the new dependency revision before synthesis can continue.

---

# 9. Proposal → Approval → Commit

This is the only path by which working design becomes committed Plan Memory.

```text
Conversation
     │
     ▼
Working Draft
     │
     ▼
Proposal
     │
     ▼
Explicit User Approval
     │
     ▼
Transaction Engine
     │
     ▼
PlanCommit
     │
     ▼
Committed Memory
```

The mental model is similar to:

```text
working tree
    ↓
staging area
    ↓
authorization
    ↓
commit
```

---

## 9.1 Proposal

A Proposal is the atomic approval unit.

A Decision is not normally an approval boundary, and an entire Section does not need to wait until completion before creating stable checkpoints.

```ts
interface Proposal {
  id: ProposalID

  type:
    | "design_checkpoint"
    | "architecture_completion"
    | "section_completion"
    | "amendment"
    | "final_plan"

  scope:
    | ArchitectureRef
    | SectionRef

  revision: number

  status:
    | "draft"
    | "ready"
    | "awaiting_approval"
    | "approved"
    | "rejected"
    | "superseded"

  title: string
  summary: string

  changes: ProposalChange[]
  dependencies: MemoryRef[]
  impact: ImpactAnalysis

  createdFrom: MemorySnapshotRef
}
```

A proposal can atomically contain several related design changes:

```text
PROP-014 — Plan Memory Persistence

ADD
+ Plugin storage is canonical state.
+ Approved revisions are immutable.
+ Event log records state transitions.
+ Markdown is generated projection.

RESOLVE
✓ Q-007 Canonical memory location

IMPACT
→ Context Assembly
→ Recovery Semantics
```

---

## 9.2 Proposal Immutability

Once a proposal enters `awaiting_approval`, it is frozen.

If discussion changes its contents:

```text
old proposal → superseded
new proposal → new revision/hash
```

The invariant is:

> **What the user approves is exactly what gets committed.**

Partial commits are not supported in v0.1.

If the user accepts A/B/C but wants D changed, the proposal is revised or split and presented again.

---

## 9.3 Approval

Approval is separate from Commit.

```ts
interface Approval {
  id: ApprovalID

  proposalID: ProposalID
  proposalRevision: number
  proposalHash: string

  actor: "user"
  createdAt: Timestamp
}
```

Approval binds to the exact immutable proposal revision.

---

## 9.4 PlanCommit

Only a `PlanCommit` may mutate committed Plan Memory.

```ts
interface PlanCommit {
  id: CommitID

  proposalID: ProposalID
  approvalID: ApprovalID

  parentCommit: CommitID | null

  changes: CommittedChange[]
  resultingSnapshot: SnapshotID

  createdAt: Timestamp
}
```

Commit validation conceptually performs:

```text
BEGIN

verify PlanningRun is active
verify Proposal is awaiting approval
verify Proposal hash matches Approval
verify base Snapshot
verify dependencies
verify hard constraints
verify conflicts
verify required repository evidence

apply changes
create immutable revisions
resolve questions
update artifact states
append event log
create Snapshot
create PlanCommit
move HEAD

COMMIT
```

Failure rolls the entire transaction back.

---

# 10. Commit Chain and Snapshots

Committed Plan Memory forms a linear commit history:

```text
COMMIT-001
    │
    ▼
COMMIT-002
    │
    ▼
COMMIT-003
    │
    ▼
COMMIT-004
```

Each commit materializes a new immutable Snapshot:

```text
S1 → S2 → S3 → S4
```

`PlanningRun` tracks:

```text
headCommit
headSnapshot
```

The Context Assembler reads authoritative design state from HEAD, not from conversation history.

Proposal base snapshots also provide optimistic concurrency protection. If HEAD changes before a proposal commits, the proposal must be revalidated; if its approved contents change, user approval must be obtained again.

---

# 11. Checkpoint and Completion Approvals

Complex Architecture and Sections may accumulate several checkpoint commits before completion.

Example:

```text
SEC-003 Plan Memory

Discussion
  ↓
Persistence Proposal
  ↓
Commit ✓

Discussion
  ↓
Retrieval Proposal
  ↓
Commit ✓

Discussion
  ↓
Recovery Proposal
  ↓
Commit ✓

Section Completion Proposal
  ↓
Approve
  ↓
SEC-003 approved
```

Completion approval does not re-approve every internal decision. It means:

> The current committed design for this artifact is complete and may be treated as a closed dependency.

There are therefore three semantic approval levels:

```text
1. Design Checkpoint Approval
   Approves a coherent group of design changes.

2. Artifact Completion Approval
   Declares an Architecture or Section complete.

3. Final Plan Approval
   Approves the complete Ultra Plan and authorizes handoff.
```

All three use the same Proposal → Approval → Commit transaction mechanism.

---

# 12. Plan Memory

Canonical Plan Memory is durable plugin-owned structured state.

It is not primarily a Markdown file inside the repository.

The logical store contains:

```text
PlanningRun
Architecture revisions
Section revisions
Section contracts
Decision revisions
Constraints
Open Questions
Conflicts
Proposals
Approvals
PlanCommits
Snapshots
Event Log
FinalPlans
```

Markdown is a generated human-readable projection.

The storage model combines:

```text
Event Log
    +
Materialized State / Snapshots
    +
Generated Markdown Views
```

---

# 13. Context Assembler

The Context Assembler is a deterministic context compiler.

It is not a RAG-first system.

v0.1 does not require:

- embeddings;
- vector databases;
- semantic reranking;
- custom repository indexes.

Structural relationships in Plan Memory provide the primary retrieval mechanism.

Pipeline:

```text
Memory Store
    │
    ▼
Structural Retrieval
    │
    ▼
Context Projection
    │
    ▼
Budget Manager
    │
    ▼
Renderer
    │
    ▼
OpenCode model request
```

---

# 14. Context Layers

Each planning inference receives logically separated context:

```text
L0 — Planning Protocol
L1 — Run State
L2 — Global Committed Memory
L3 — Active Scope Memory
L4 — Working Context
L5 — Available Harness Operations
```

## L0 — Planning Protocol

Compact rules describing Ultra Plan semantics and the current planning stage.

## L1 — Run State

Example:

```yaml
ultra_plan:
  plan: PLAN-001
  stage: detail

  active:
    type: section
    id: SEC-006
    title: Recovery Semantics

  head_commit: COMMIT-019

  progress:
    architecture: approved
    sections:
      approved: 4
      active: 1
      pending: 2

  blockers:
    questions: 1
    conflicts: 0
```

## L2 — Global Committed Memory

Always includes:

- goal;
- hard constraints;
- compact approved architecture projection.

## L3 — Active Scope

For an active section:

1. active section;
2. direct dependencies;
3. section-scoped decisions;
4. inherited dependency decisions;
5. relevant interfaces;
6. open questions;
7. conflicts;
8. downstream impact summary.

## L4 — Working Context

Working design is explicitly separated from committed design.

```text
=== COMMITTED MEMORY ===

DEC-014
Approved revisions are immutable.

=== CURRENT WORKING DISCUSSION ===

Automatic rollback has been proposed.

This is NOT committed memory.
```

OpenCode continues to provide recent conversation history. Ultra Plan does not duplicate the full conversation.

## L5 — Operations

The available Ultra Plan tool surface changes according to workflow state.

The state machine is therefore enforced not only by prompting, but by capability exposure.

---

# 15. Context Projection

Memory objects and model-visible context fragments are different things.

Artifacts support projection levels such as:

```ts
type DetailLevel =
  | "identity"
  | "summary"
  | "relevant"
  | "full"
```

For example, an Architecture may have:

```text
ARCH@3:compact
ARCH@3:full
```

An approved Section additionally has a `SectionContract`.

Default dependency retrieval follows:

```text
active artifact
    → relevant/full

direct dependencies
    → relevant/contract

transitive dependencies
    → contract/identity
```

This prevents the entire plan from recursively entering every model request.

Explicit user references may temporarily increase the detail level of a memory object without changing workflow state.

---

# 16. Context Budget

Fragments compete for a token budget by priority.

```text
P0 — Never Drop
Protocol
Current state
Goal
Hard constraints
Active artifact identity
Blocking conflicts/questions

P1 — High
Active artifact
Direct dependency contracts
Direct decisions
Current Proposal

P2 — Medium
Architecture compact projection
Transitive dependencies
Downstream impact

P3 — Optional
Detailed rationale
Alternatives
Historical revisions
Non-blocking supporting context
```

Budget pressure first removes or compresses lower-priority fragments. P0 content is never dropped.

---

# 17. Stable Projections

Committed memory is not dynamically re-summarized on every request.

Canonical projections are produced as part of the proposal/revision being approved and become part of the immutable revision.

This prevents summarization drift.

A proposal can therefore include:

```text
full design
+
compact projection
+
contract projection
```

The user's approval covers all three.

---

# 18. Compaction Independence

Ultra Plan does not rely on OpenCode conversation history to preserve approved design.

After OpenCode compaction, the next inference reconstructs planning context from:

```text
PlanningRun
HEAD Snapshot
Architecture
Active Section
Dependency Contracts
Decisions
Questions
Conflicts
Current Proposal
Repository Evidence
```

Therefore:

> Conversation compaction may remove discussion detail, but it cannot remove committed design state.

---

# 19. Context Trace

Every context assembly may generate an observability record:

```ts
interface ContextTrace {
  id: ContextTraceID

  headCommit: CommitID
  stage: PlanningStage
  activeWork?: WorkRef

  included: {
    ref: MemoryRef
    projection: DetailLevel
    reason: RetrievalReason
    estimatedTokens: number
  }[]

  excluded: {
    ref: MemoryRef
    reason: string
  }[]

  totalTokens: number
}
```

Retrieval reasons can include:

```text
global_constraint
active_scope
direct_dependency
transitive_dependency
explicit_reference
blocking_conflict
open_question
current_proposal
```

This makes planning quality and retrieval decisions debuggable.

---

# 20. Read-Only Plan Memory Access

The planning model may use a read-only `plan_memory` capability to inspect memory beyond the automatically assembled context.

Conceptually:

```text
plan_memory(ref="SEC-003", detail="full")
plan_memory(ref="DEC-014")
plan_memory(dependencies="SEC-006")
```

This capability never writes committed state.

All writes still require:

```text
Proposal → Approval → PlanCommit
```

---

# 21. Repository Intelligence

Plan Memory and Repository Evidence are separate trust domains.

```text
PLAN MEMORY
"What have we decided?"

authoritative
approved
versioned
user-authorized
```

versus:

```text
REPOSITORY EVIDENCE
"What have we observed?"

source-backed
freshness-aware
repository-derived
```

Ultra Plan does not build a new repository crawler, AST database, vector index, or search engine.

Repository exploration continues through OpenCode-native tools.

Ultra Plan adds provenance and persistence to planning-relevant observations.

---

# 22. Observation Ledger

OpenCode tools may produce temporary Observations.

```ts
interface Observation {
  id: ObservationID

  tool: string
  source?: SourceLocator

  observedAt: Timestamp
  contentFingerprint?: string
}
```

Examples:

```text
read file
grep symbol
inspect configuration
run test
run command
inspect package metadata
```

Observations are cheap and temporary.

They do not automatically become Evidence.

---

# 23. Evidence

The planning model explicitly promotes planning-relevant observations into Evidence.

```ts
interface Evidence {
  id: EvidenceID
  revision: number

  kind: EvidenceKind

  claim: string

  source: EvidenceSource[]
  scope: EvidenceScope

  confidence:
    | "direct"
    | "derived"
    | "uncertain"

  criticality:
    | "critical"
    | "supporting"
    | "informational"

  freshness:
    | "fresh"
    | "needs_validation"
    | "stale"

  status:
    | "active"
    | "stale"
    | "invalidated"

  derivedFrom?: EvidenceRef[]

  discoveredAt: Timestamp
  lastValidatedAt: Timestamp
}
```

Evidence kinds may include:

```text
file
symbol
interface
dependency
configuration
behavior
test
runtime
architecture
```

---

# 24. Evidence Sources

Evidence records claims, not large code excerpts.

Every direct Evidence record must have source provenance.

```ts
interface EvidenceSource {
  type:
    | "file"
    | "symbol"
    | "command"
    | "test"
    | "package_metadata"
    | "runtime"

  path?: string
  symbol?: string

  range?: {
    startLine: number
    endLine: number
  }

  command?: string

  revision?: RepositoryRevision
  contentHash?: string
}
```

A direct Evidence claim cannot be created solely from model memory. It must reference actual observations or repository sources accessed during the planning session.

---

# 25. Repository Revision and Freshness

Evidence must account for both version-control state and uncommitted workspace changes.

```ts
interface RepositoryRevision {
  vcs?: {
    type: "git"
    commit?: string
    branch?: string
  }

  workspaceFingerprint: string
}
```

Correctness does not depend on hashing the entire repository.

Evidence freshness is normally checked against the specific source files or symbols on which the claim depends.

When a source changes:

```text
fresh
   ↓
needs_validation
```

After reinspection:

```text
claim still true
   → new fresh Evidence revision

claim changed
   → stale / conflicting Evidence
```

Evidence revisions are immutable but do not require user approval.

---

# 26. Direct, Derived, and Uncertain Evidence

Direct Evidence comes directly from inspected repository/runtime sources.

Derived Evidence is inferred from other Evidence and must reference those upstream records.

Uncertain Evidence represents plausible but insufficiently verified observations.

Critical design decisions should not rely solely on uncertain Evidence.

Example:

```text
EVD-101 [direct]
Session exposes switchModel().

EVD-102 [direct]
Agent can switch within the existing session.

EVD-103 [derived]
Model and agent handoff can likely preserve
conversation continuity.

derivedFrom:
  EVD-101
  EVD-102
```

---

# 27. Evidence and Decisions

Decisions may reference supporting Evidence:

```text
Repository
    │
    ▼
Observation
    │
    ▼
Evidence
    │
    ▼
Decision
    │
    ▼
Proposal
    │
    ▼
Approval
    │
    ▼
PlanCommit
```

Evidence is optional for pure design choices, but repository-dependent claims should be evidence-backed.

This creates an explicit provenance graph between repository reality and approved design.

---

# 28. Evidence Retrieval

Context Assembler retrieves Evidence through structural scope and decision relationships.

Priority:

```text
P0
Evidence for blocking conflicts/questions

P1
Evidence referenced by active Decisions
Evidence scoped directly to active Section

P2
Dependency/architecture evidence

P3
Derived or supplementary evidence
```

Default model-visible form is compact:

```text
EVD-037 [fresh/direct/critical]
OpenCode session supports active model switching.
source: packages/.../session.ts::switchModel
```

Full source detail is loaded only when required.

---

# 29. Evidence Validation

Proposal commit revalidates critical Evidence on which the proposal depends.

If evidence sources changed:

```text
Proposal
   │
   ▼
Evidence validation
   │
   ├── claim unchanged
   │      → refresh evidence revision
   │
   └── claim changed
          → supersede/revise proposal
```

If an already approved design loses its supporting evidence:

```text
Evidence invalidated
       │
       ▼
Conflict
       │
       ▼
Affected Section
validation = needs_review
       │
       ▼
reopen if required
```

Approved Plan Memory is never silently rewritten because repository facts changed.

---

# 30. Evidence Audit Before Final Plan

Before final synthesis/final approval, Ultra Plan audits Evidence reachable from approved architecture, sections, decisions, and contracts.

Example report:

```text
Evidence Validation

Fresh direct:         37
Fresh derived:        11
Needs validation:      2
Stale:                 0
Critical uncertain:    1
```

Critical Evidence must be fresh before Final Approval.

Supporting Evidence is revalidated when its source changed.

Informational Evidence does not block finalization.

---

# 31. Synthesis

Synthesis operates over approved memory.

It may:

- organize approved design;
- normalize terminology;
- derive implementation order;
- connect interfaces;
- identify inconsistencies;
- detect missing design.

It may not silently introduce new architectural facts.

If synthesis discovers that new design is required:

```text
SYNTHESIS
    │
    ▼
raise question/conflict
    │
    ▼
DETAIL / REOPEN
    │
    ▼
Proposal → Approval → Commit
    │
    ▼
SYNTHESIS
```

Thus:

> **Synthesis is a projection of approved design, not another uncontrolled design phase.**

---

# 32. Final Plan

The Final Plan is an immutable snapshot referencing exact approved revisions.

```ts
interface FinalPlan {
  id: FinalPlanID
  revision: number

  architecture: ArchitectureRef
  sections: SectionRevisionRef[]
  decisions: DecisionRef[]
  constraints: ConstraintRef[]

  implementationOrder: ImplementationStep[]

  validation: {
    blockingQuestions: 0
    blockingConflicts: 0
    invalidSections: 0
  }

  body: string

  status:
    | "awaiting_approval"
    | "approved"

  approvedAt?: Timestamp
}
```

References include exact revisions:

```text
ARCH@3
SEC-001@2
SEC-002@5
DEC-014@1
```

The Final Plan therefore remains stable even if planning data later evolves.

---

# 33. Final Approval and Handoff

Only explicit Final Plan approval may exit Ultra Plan.

Preconditions include:

```text
FinalPlan approved
AND
blockingQuestions == 0
AND
blockingConflicts == 0
AND
all required Sections approved
AND
all required Sections valid
AND
critical Evidence fresh
```

The transition is:

```text
Final Approval
      │
      ▼
Final PlanCommit
      │
      ▼
PlanningRun = handoff_pending
      │
      ▼
switch execution model
      │
      ▼
switch execution/build agent
      │
      ▼
inject execution handoff
      │
      ▼
handoff complete
      │
      ▼
PlanningRun.lifecycle = completed
```

The final design is committed before runtime handoff begins.

This makes crash recovery deterministic.

---

# 34. Execution Handoff

The Build agent should not receive the entire raw planning history.

It receives a concise execution handoff referencing the immutable Final Plan:

```text
Execution Handoff

Plan:
PLAN-001 / Final Revision 7

Goal:
...

Approved Architecture:
...

Implementation Order:
1. ...
2. ...
3. ...

Critical Constraints:
...

Relevant Decisions:
DEC-001
DEC-004
DEC-012
```

The execution side may be given read-only access to approved Plan Memory when deeper detail is required.

Planning conversation history remains in the same OpenCode session, but the Final Plan is the authoritative execution contract.

---

# 35. Core Invariants

The frozen architecture establishes the following invariants.

1. `/ultra-plan` is the Harness entry point.
2. OpenCode owns runtime, conversation, repository tools, and execution.
3. Ultra Plan owns planning workflow, committed planning state, approval, context construction, and evidence.
4. One OpenCode session has at most one active `PlanningRun`.
5. Planning and execution remain in the same OpenCode session.
6. State-machine stage and artifact status are separate concepts.
7. Committed Plan Memory uses immutable revisions.
8. Only a `PlanCommit` can mutate committed Plan Memory.
9. Every `PlanCommit` requires explicit user approval of an exact Proposal revision.
10. Proposal is the atomic transaction boundary; v0.1 has no partial commits.
11. Approved design cannot be silently edited.
12. Changes to approved design require reopen/amendment through the normal transaction pipeline.
13. Dependency changes propagate `needs_review` to affected downstream artifacts.
14. Architecture decomposition produces a project-specific Section DAG.
15. Complex artifacts may use multiple checkpoint commits before completion.
16. Completion approval means an artifact is complete; it does not re-approve every internal Decision.
17. Synthesis cannot create unapproved design facts.
18. Final Plan is an immutable snapshot of exact approved revisions.
19. Only explicit Final Plan approval authorizes execution handoff.
20. Handoff is recoverable through `handoff_pending`.
21. Context construction is deterministic and structure-first.
22. v0.1 does not require embeddings or a vector database.
23. Committed Memory and Working Discussion are explicitly separated in model context.
24. Conversation compaction cannot remove committed design state.
25. Repository Evidence and Plan Memory are separate trust domains.
26. Direct Evidence requires actual source provenance.
27. Evidence changes never silently rewrite approved Plan Memory.
28. Critical Evidence must be fresh before final approval.
29. Repository exploration uses OpenCode-native capabilities rather than a custom crawler/indexer.
30. Context retrieval and evidence retrieval remain observable through traces/provenance.

---

# 36. Frozen v0.1 Non-Goals

The current architecture deliberately excludes:

- prompt-complexity-based model routing;
- automatic task classification for model selection;
- subagent orchestration as the core planning mechanism;
- a second conversation/session for planning;
- custom repository crawler;
- custom AST index;
- vector database;
- embeddings;
- semantic reranking;
- external-document evidence;
- Markdown as the canonical database;
- regex-based workflow control;
- implicit model-controlled commits;
- model-controlled final handoff;
- partial Proposal commits;
- reliance on OpenCode conversation summaries for committed design memory.

---

# 37. Current Module Boundaries

A likely implementation layout is:

```text
opencode-ultra-plan/
│
├── src/
│   ├── index.ts
│   │
│   ├── core/
│   │   ├── controller.ts
│   │   ├── state-machine.ts
│   │   ├── invariants.ts
│   │   └── recovery.ts
│   │
│   ├── transaction/
│   │   ├── proposals.ts
│   │   ├── approvals.ts
│   │   ├── commits.ts
│   │   └── validation.ts
│   │
│   ├── memory/
│   │   ├── store.ts
│   │   ├── snapshots.ts
│   │   ├── events.ts
│   │   ├── projection.ts
│   │   └── renderer.ts
│   │
│   ├── context/
│   │   ├── assembler.ts
│   │   ├── retrieval.ts
│   │   ├── budget.ts
│   │   ├── protocol.ts
│   │   └── trace.ts
│   │
│   ├── repository/
│   │   ├── observations.ts
│   │   ├── evidence.ts
│   │   ├── sources.ts
│   │   ├── freshness.ts
│   │   ├── graph.ts
│   │   └── audit.ts
│   │
│   ├── model/
│   │   └── policy.ts
│   │
│   ├── tools/
│   │   └── ...
│   │
│   └── tui.tsx
│
└── package.json
```

The exact tool contracts and UI are intentionally not frozen yet.

---

# 38. Next Architecture Layer

The next unresolved layer is:

## Planning Agent Protocol + Tool Contract

The architecture now defines:

- workflow state;
- durable Plan Memory;
- proposals and transactions;
- approvals;
- revisions and snapshots;
- section dependency graph;
- context retrieval;
- compaction independence;
- repository observations;
- evidence provenance;
- evidence freshness;
- final synthesis and handoff.

The next layer must define how the frontier planning model interacts with this machinery.

In particular:

```text
Which tools exist?
Which states expose each tool?
Which operations are read-only?
Which operations may create proposals?
How are repository observations promoted to Evidence?
How does the agent raise conflicts?
How does it request reopen?
How does it declare an artifact ready for completion?
How is final synthesis requested?
Which actions can never be performed by the model?
```

The guiding security/reliability boundary remains:

```text
LLM
 │
 │ proposes / reasons / explores
 ▼
Harness Tools
 │
 │ validate capabilities and state
 ▼
Controller / Transaction Engine
 │
 │ enforce invariants
 ▼
Committed Plan Memory
```

The model is the planning intelligence.

The Harness is the workflow authority.
