# Claude Code Phase Plan — Architecture Specification

**Status:** Frozen v0.1 architecture baseline  
**Target host:** Claude Code  
**Working product name:** Phase Plan  
**Primary entry point:** `/phase-plan`  
**Planning model tier:** Opus  
**Execution model tier:** Sonnet via Claude Code native `opusplan` behavior  
**Runtime prerequisite:** Node.js 24.15+  
**Canonical persistence:** SQLite in `${CLAUDE_PLUGIN_DATA}`  
**Architecture date:** 2026-09-24

---

## 1. Purpose

Phase Plan is a persistent, approval-driven planning harness for Claude Code.

It is not a replacement for Claude Code's conversation/session runtime, model inference, repository tools, permission system, Plan Mode, compaction, subagents, or execution environment. Claude Code remains the host runtime.

Phase Plan adds a deterministic planning workflow around Claude Code:

- use Opus throughout the planning lifecycle;
- progressively design architecture rather than emit a one-shot plan;
- require explicit user authorization before design knowledge becomes committed;
- preserve approved planning state independently from conversation compaction;
- maintain provenance between repository observations, Evidence, Decisions, and Proposals;
- detect conflicts, stale Evidence, invalidated dependencies, and incomplete design;
- synthesize a final execution contract only from approved state;
- perform independent semantic validation before finalization;
- use a deterministic Finalization Gate before Final Approval;
- automatically hand the same Claude Code session from Plan Mode to Build after Final Approval;
- keep Build execution subordinate to the approved Final Plan without turning Phase Plan into an execution orchestrator.

The fundamental ownership boundary is:

> **Claude Code owns runtime, conversation, models, tools, Plan Mode, permission handling, compaction, and execution. Phase Plan owns planning workflow, committed planning state, approvals, context construction, repository Evidence, synthesis validation, finalization, and execution-contract handoff.**

---

## 2. Relationship to the OpenCode Architecture

The planning protocol is intentionally host-independent.

The following concepts remain shared with the OpenCode architecture:

- `PlanningRun`;
- stage/lifecycle separation;
- immutable Architecture, Section, Decision, Evidence, Proposal, Commit, Snapshot, and Final Plan revisions;
- Proposal → Approval → PlanCommit as the only path into committed planning state;
- dynamic Section DAG;
- Context Assembler;
- Observation/Evidence provenance;
- Evidence freshness and invalidation;
- reopen/amendment semantics;
- synthesis as a projection of approved state;
- deterministic finalization;
- immutable execution handoff.

Claude Code changes only the host adapter, model policy realization, permission-mode integration, plugin/runtime topology, and session/recovery mechanics.

---

## 3. Top-Level Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                         Claude Code                          │
│                                                              │
│ conversation / session / inference / tools / compaction      │
│ native Plan Mode / permission UI / subagents                 │
└──────────────────────────────┬───────────────────────────────┘
                               │
                         /phase-plan
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                     Claude Adapter                           │
│                                                              │
│  Skill        Hooks        MCP Adapter       Validator Agent │
│  entry        lifecycle    model-facing API  semantic review │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                     Phase Plan Core                          │
│                                                              │
│ State Machine / Transactions / Plan Memory / Context          │
│ Evidence / Synthesis / Validation / Finalization / Recovery   │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                      Plan Store                              │
│                                                              │
│ SQLite + immutable revisions + snapshots + event log          │
│ content-addressed temporary blob store                        │
└──────────────────────────────────────────────────────────────┘
```

The model is planning intelligence.

The Core is workflow authority.

The Store is persistence authority.

Claude Code is runtime authority.

---

## 4. Naming and Entry Point

The Claude Code implementation does **not** use the name `Ultra Plan`, to avoid confusion with Claude Code's own planning features and commands.

The working name is:

```text
Phase Plan
```

The v0.1 user entry point is:

```text
/phase-plan
```

The entry command is semantically `start_or_resume`, not a pure `start` operation.

---

## 5. Model Policy

### 5.1 Claude Code v0.1 policy

Phase Plan deliberately adopts Claude Code's native planning/execution model split:

```text
planning tier  = Opus
execution tier = Sonnet
```

The implementation should use Claude Code's native `opusplan` behavior where available:

```text
Plan Mode   → Opus
Build Mode  → Sonnet
```

No custom main-session ModelController is required in v0.1.

### 5.2 Core abstraction

The Phase Plan Core remains provider-neutral:

```text
planning policy  → planning tier
execution policy → execution tier
```

Concrete Claude model names belong to the Claude adapter, not the planning protocol.

### 5.3 Non-goals

v0.1 does not implement:

- prompt-complexity routing;
- automatic model classification;
- arbitrary phase-to-model switching;
- an Agent SDK wrapper solely to control models;
- planning as a main-model subagent delegation pattern.

---

## 6. Claude Plan Mode Integration

### 6.1 Authority separation

`PlanningRun` is the authoritative planning lifecycle state.

Claude Plan Mode is the host execution/write boundary.

Therefore:

```text
Claude permission_mode == plan
```

is not equivalent to:

```text
PlanningRun.lifecycle == active
```

A user changing Claude's permission mode does not complete or abort Phase Plan.

### 6.2 Entering Phase Plan

Conceptually:

```text
/phase-plan
    ↓
start_or_resume
    ↓
create/resume PlanningRun
    ↓
session-scoped permission transition → plan
    ↓
activate Phase Plan context
    ↓
DISCOVERY
```

Permission-mode changes must be session-scoped. Phase Plan must not persist its planning lifecycle into user-level or project-level Claude permission settings.

### 6.3 Host-state drift

If an active PlanningRun exists but Claude leaves Plan Mode prematurely, this is host-state drift, not a completed planning workflow.

v0.1 uses two fail-closed layers:

1. `UserPromptSubmit` guard: block a new planning turn if the active run expects Plan Mode but the host is not in Plan Mode.
2. `PreToolUse` guard: deny mutating execution tools while the PlanningRun remains active.

Claude Plan Mode is the primary boundary; Phase Plan guards are the correctness backstop.

### 6.4 Plan Mode recovery after resume (Amendment A1)

PlanningRun recovery and Claude permission-mode recovery are distinct operations (RI-22).

Documented Claude Code behavior never restores Plan Mode on the interactive exact-session `/resume` path, and `SessionStart` cannot set the permission mode. Therefore:

```text
/resume
    ↓
recover exact Phase Plan authoritative state
    ↓
reattach exact-session PlanningRun when legal
    ↓
inspect current Claude permission mode

if permission_mode == plan:
    planning may continue

if permission_mode != plan:
    mode recovery is required
    ↓
    block ordinary Phase Plan continuation (fail-closed)
    ↓
    user explicitly invokes /phase-plan
    ↓
    existing EntryIntent / HostContext path
    ↓
    start_or_resume returns the SAME PlanningRun
    ↓
    PermissionRequest setMode(plan, session)
    ↓
    planning continues
```

`/phase-plan` re-entry for mode recovery is host-mode recovery authorization. It is not Proposal Approval, PlanCommit Approval, Final Approval, or takeover: committed design stays committed, an awaiting Proposal stays awaiting, no reapproval is caused by the host dropping Plan Mode, and the re-entered run is always the same PlanningRun (never created, duplicated, superseded, or reset). Mode recovery is never triggered by SessionStart, model inference, the MCP process environment, or conversation text — only by the user-invoked `/phase-plan` with a fresh signed EntryIntent.

Phase Plan never persists Claude Plan Mode into user, project, or local settings solely to survive session resume (CC-11). No `mode_recovery_required` lifecycle/state exists: the condition is derived from `active PlanningRun + current session ownership + permission_mode != plan`.

### 6.5 Final exit

Only this sequence authorizes exit:

```text
Final Approval
    ↓
Final PlanCommit
    ↓
PlanningRun = handoff_pending
    ↓
host permission mode → Build/default
    ↓
Execution Handoff delivered
    ↓
PlanningRun = completed
```

`handoff_pending` is recoverable and must not be collapsed into `completed` prematurely.

---

## 7. PlanningRun State Model

```ts
interface PlanningRun {
  id: PlanID
  workspaceID: WorkspaceID

  lifecycle:
    | "active"
    | "completed"
    | "aborted"

  stage:
    | "discovery"
    | "architecture"
    | "detail"
    | "synthesis"
    | "validation"
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

Execution is not a planning stage.

`handoff_pending` is a recoverable transition condition around final handoff, not a normal design stage.

---

## 8. Planning Lifecycle

```text
IDLE
 │
 │ /phase-plan
 ▼
DISCOVERY
 │
 ▼
ARCHITECTURE
 │
 │ architecture checkpoints/completion
 ▼
DETAIL
 │
 ├── section design
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
 ├── finding/conflict → DETAIL / REOPEN
 │
 └── clean
        │
        ▼
FINAL
 │
 │ explicit Final Approval
 ▼
FINAL PLANCOMMIT
 │
 ▼
HANDOFF_PENDING
 │
 ▼
BUILD MODE / SONNET
 │
 ▼
COMPLETED
```

---

## 9. Plan Memory

Canonical Plan Memory is structured plugin-owned state.

It is not:

- the Claude conversation transcript;
- Claude's compact summary;
- `CLAUDE.md`;
- Claude Auto Memory;
- generated Markdown.

Logical store contents include:

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
Observation metadata
Evidence revisions
Evidence validation events
Synthesis manifests
Semantic validation reports
FinalPlans
ExecutionBindings
ExecutionIssues
Audit Events
```

Markdown is a generated projection.

---

## 10. Planning Artifacts

### 10.1 Constraints

Constraints describe conditions the design must satisfy.

Hard constraints can block proposals and finalization.

### 10.2 Decisions

Decisions are atomic units of durable design knowledge.

Approved Decision revisions are immutable.

Changing an approved Decision requires a superseding revision through Proposal → Approval → PlanCommit.

### 10.3 Architecture

Architecture is the approved top-level design snapshot.

Architecture describes the system as a whole; Decisions explain durable choices shaping it.

### 10.4 Sections

After Architecture approval, Opus decomposes the design into a project-specific Section DAG.

Sections are not predefined categories.

### 10.5 Section revisions and contracts

Each approved Section revision includes structured design plus stable projections.

Each approved Section produces an immutable `SectionContract` containing the dependency-facing subset:

```text
provides
requires
invariants
interfaces
decisions
```

Downstream work should normally consume contracts instead of recursively loading entire dependency designs.

---

## 11. Working State vs Committed State

Working discussion may change freely.

Committed planning state may not be silently rewritten.

```text
Conversation / exploration
        ↓
Working draft
        ↓
Proposal
        ↓
Explicit human authorization
        ↓
PlanCommit
        ↓
Committed Plan Memory
```

Approved design can only change through reopen/amendment and a new approval transaction.

---

## 12. Proposal → Approval → PlanCommit

### 12.1 Proposal

Proposal is the atomic design-authorization unit.

Supported proposal types include:

```text
design_checkpoint
architecture_completion
section_completion
amendment
final_plan
```

A Proposal becomes immutable when it reaches `awaiting_approval`.

If discussion changes its contents, the old Proposal is superseded and a new revision/hash is created.

### 12.2 Approval

Formal Approval is not inferred directly from natural-language agreement.

Natural-language statements such as:

```text
可以
继续
这个方案可以
```

express approval intent only.

Formal authorization occurs through a dedicated MCP tool:

```text
phase_plan.approve_proposal(
  proposal_id,
  proposal_revision,
  proposal_hash
)
```

The tool must require real user interaction through Claude Code's mandatory-interaction MCP metadata.

Approval binds to the exact frozen Proposal revision/hash.

### 12.3 Deny/cancel semantics

Deny or cancel means only:

```text
this commit was not authorized
```

It does not imply Proposal rejection or supersession.

### 12.4 PlanCommit

Only PlanCommit may mutate committed planning state.

After user authorization, the server independently revalidates:

```text
PlanningRun lifecycle
session ownership/fencing
store schema compatibility
Proposal identity/hash
expected HEAD/base Snapshot
dependencies
hard constraints
blocking conflicts/questions
required Evidence freshness
```

Only then is the commit performed.

All committed mutations are idempotent across crash/retry.

---

## 13. Approval Interaction Primitives

### 13.1 Formal Approval

Formal Approval uses a mandatory-user-interaction MCP mutation tool.

### 13.2 AskUserQuestion

`AskUserQuestion` is for:

- requirement clarification;
- choosing alternatives;
- structured design discussion;
- resolving open design questions before Proposal creation.

It is not the formal transaction authorization primitive.

### 13.3 MCP Elicitation

MCP Elicitation may be used later for rich structured input but is not the v0.1 formal Approval mechanism.

### 13.4 Fail-closed version gate

If the installed Claude Code version cannot guarantee the mandatory-user-interaction behavior required by Phase Plan, transactional approval must fail closed.

---

## 14. Context Architecture

### 14.1 Context is a projection, not authority

Plan Memory determines correctness.

Claude context determines what the model currently sees.

Context-injection failure may reduce reasoning quality but must not permit invalid state mutation.

### 14.2 Context layers

Logical layers:

```text
L0 Planning Protocol
L1 Run State
L2 Global Committed Memory
L3 Active Scope Memory
L4 Working Context
L5 Available Operations
```

### 14.3 Recovery Context Capsule

On `SessionStart(startup/resume/compact)` for an active run, Phase Plan injects a deterministic Recovery Context Capsule containing at minimum:

```text
PlanningRun ID
stage
HEAD Commit / Snapshot
active scope
goal
hard constraints
compact approved Architecture
active Section projection
direct dependency contracts
blocking Questions/Conflicts
current Proposal if any
context epoch
```

When the recovered session's host permission mode is not `plan`, the capsule must additionally state clearly (Amendment A1, §6.4):

```text
Phase Plan run recovered.
Claude Plan Mode must be restored by invoking /phase-plan.
```

SessionStart never claims to restore Plan Mode, and no model planning work proceeds from this context alone.

### 14.4 Normal turns

Normal turns use delta context where possible instead of reinjecting the entire Plan Memory.

### 14.5 Compaction

Phase Plan does not block Claude's normal compaction in v0.1.

After compaction:

```text
Claude compact summary
    → non-authoritative

HEAD Snapshot
    → authoritative recovery source
```

Compact summaries never write back into Plan Memory.

### 14.6 Stale-context safety

All mutating operations carry/derive an expected HEAD or base Snapshot.

If current HEAD differs, Core returns a machine-readable stale-state error and the model must reload context.

---

## 15. Repository Observation

### 15.1 Automatic Observation, explicit Evidence

While a PlanningRun is active:

```text
Claude repository tools
        ↓
automatic Observation capture
        ↓
Observation Ledger
        ↓
explicit promote_evidence
        ↓
Evidence
```

Observation is temporary, non-authoritative, and cheap.

Evidence is durable planning provenance.

### 15.2 Capture mechanism

v0.1 prefers synchronous `PostToolBatch` capture for evidence-capable tools.

This avoids per-tool concurrency races and records the tool results actually delivered to Claude.

### 15.3 Observation classes

```text
source observations:
  Read

locator observations:
  Grep
  Glob

execution observations:
  Bash
  PowerShell
```

No LLM summarization, embedding, semantic indexing, AST analysis, or repository crawling runs in the Observation hook.

### 15.4 `@file` context

Files injected only through `@file` prompt context are discussion input but are not attributable repository Evidence until accessed through an observable repository tool call.

### 15.5 Subagents

Subagent tool observations may be captured.

Subagent prose/conclusions are not themselves direct Evidence.

---

## 16. Evidence

Evidence records planning-relevant claims supported by actual observations.

Each Evidence revision includes:

```text
claim
kind
source provenance
scope
confidence
criticality
validation strategy
repository/workspace revision context
source fingerprints where applicable
derivedFrom where applicable
```

Confidence classes:

```text
direct
derived
uncertain
```

Criticality classes:

```text
critical
supporting
informational
```

Direct Evidence must reference actual captured Observations.

Derived Evidence must reference exact upstream Evidence revisions.

Evidence does not require user approval; design consequences derived from Evidence do.

---

## 17. Evidence Freshness and Invalidation

### 17.1 Meaning of freshness

`fresh` means last-known validated against the recorded source state.

It is not a permanent guarantee that the source has never changed afterward.

Logical states:

```text
fresh
needs_validation
stale
invalidated
```

### 17.2 Immutable Evidence revisions

Evidence revisions are immutable.

Freshness/invalidation changes are recorded through append-only validation/invalidation events and a materialized current state.

### 17.3 File/source validation

v0.1 uses whole-file fingerprints for static source Evidence.

It does not require:

- AST fingerprints;
- symbol-level hashes;
- semantic hashes.

Repository revision is provenance/coarse change context; source fingerprints are the authoritative static-source validation mechanism.

### 17.4 Validation strategies

v0.1 supports:

```text
fingerprint
reobserve
```

Static files/configuration generally use fingerprint validation.

Tests, commands, and runtime observations generally require re-observation.

Phase Plan never automatically re-executes arbitrary commands merely to refresh Evidence.

### 17.5 FileChanged

Claude `FileChanged` events may mark Evidence `needs_validation` early.

They are optimization hints only.

Correctness is enforced again at transaction/finalization gates.

### 17.6 Changed source

If a source fingerprint changes:

```text
fresh
  ↓
needs_validation
  ↓
new Observation
  ↓
semantic revalidation by Planning Agent
```

If the claim remains true, create a new fresh Evidence revision.

If the claim changes, invalidate dependent design and create conflicts/review requirements through the normal workflow.

### 17.7 Derived propagation

When an exact upstream Evidence revision changes, dependent derived Evidence becomes `needs_validation`.

Derived Evidence must be revalidated against the new exact upstream revisions.

### 17.8 Gate levels

Ordinary discussion does not revalidate all Evidence.

Proposal commit validates critical Evidence reachable from that Proposal.

Artifact completion validates critical Evidence reachable from that Architecture/Section.

Finalization audits all reachable Evidence:

```text
critical:
  must be fresh

supporting:
  must be revalidated when its source changed

informational:
  non-blocking
```

Freshness is checked again after user authorization and before PlanCommit.

---

## 18. Synthesis

### 18.1 Authority

Synthesis is performed by the main planning Opus.

It operates on a frozen `SynthesisInput` anchored to an exact HEAD Snapshot.

### 18.2 Inputs

The frozen input includes exact approved revisions of:

```text
Architecture
Sections
SectionContracts
Decisions
Constraints
resolved Questions
resolved Conflicts
relevant Evidence state
```

If HEAD changes while synthesis is in progress, the synthesis becomes stale.

### 18.3 Synthesis is not another design phase

During synthesis, normal design-mutation capabilities are unavailable.

Synthesis may:

- organize approved design;
- connect approved interfaces;
- derive implementation order;
- normalize terminology;
- identify inconsistencies or missing design;
- record limitations.

Synthesis may not introduce new normative design choices.

If new design is required, synthesis must request reopen and return to Detail.

### 18.4 Stable projections

Approved compact/contract projections are reused directly.

Synthesis does not re-summarize all approved design from raw conversation.

### 18.5 SynthesisManifest

Derived synthesis statements include exact approved provenance refs.

Conceptually:

```ts
interface SynthesisManifest {
  baseSnapshot: SnapshotRef
  architecture: ArchitectureRef
  sections: SectionRevisionRef[]

  crossSectionLinks: DerivedStatement[]
  implementationOrder: ImplementationStep[]
  limitations: DerivedStatement[]

  unresolvedFindings: ValidationFinding[]
}
```

Every derived statement identifies the exact approved refs supporting it.

---

## 19. Semantic Validation

Semantic Validation is performed by an isolated read-only Opus validator subagent.

It receives:

```text
Frozen SynthesisInput
SynthesisManifest
approved projections
exact refs
```

It does not receive raw planning discussion as authority.

Validator findings include:

```text
unsupported_new_fact
contradiction
missing_design
missing_dependency
incorrect_derivation
coverage_gap
clean
```

The validator is a detector, not a resolver.

It may submit findings but cannot:

- create Proposals;
- approve;
- commit;
- reopen;
- mutate Plan Memory;
- resolve conflicts;
- finalize.

---

## 20. Finalization

Finalization authority belongs exclusively to Phase Plan Core.

The model may request finalization but cannot declare finalization successful.

Conceptual deterministic gate:

```text
PlanningRun active?
stage == validation?
SynthesisInput Snapshot == current HEAD?
Architecture approved?
all required Sections approved?
all Sections valid?
blocking Questions == 0?
blocking Conflicts == 0?
no reopened artifacts?
no unresolved synthesis findings?
Evidence audit passes?
critical Evidence fresh?
SynthesisManifest refs exact and approved?
Semantic Validation clean?
```

No force/bypass flags exist.

Only a clean gate may create a `FinalPlanCandidate`.

Final Approval uses the normal formal Approval protocol.

The Finalization Gate is rerun after user authorization and immediately before Final PlanCommit.

---

## 21. Final Plan

The Final Plan is an immutable structured snapshot referencing exact approved revisions.

```ts
interface FinalPlan {
  id: FinalPlanID
  revision: number

  architecture: ArchitectureRef
  sections: SectionRevisionRef[]
  decisions: DecisionRef[]
  constraints: ConstraintRef[]

  synthesisManifest: SynthesisManifestRef
  implementationOrder: ImplementationStep[]

  validation: {
    blockingQuestions: 0
    blockingConflicts: 0
    invalidSections: 0
    semanticValidation: "clean"
  }

  evidenceAudit: EvidenceAuditSnapshot

  status:
    | "awaiting_approval"
    | "approved"

  approvedAt?: Timestamp
}
```

Generated Final Plan Markdown is a human-readable projection, not canonical state.

---

## 22. Final Plan → Build Handoff

### 22.1 Authorization semantics

Final Approval authorizes the automatic transition from Phase Plan to Build.

It does not authorize bypassing Claude Code's normal execution/tool permissions.

### 22.2 ExecutionHandoff

ExecutionHandoff is deterministically rendered from the approved Final Plan.

It is not a freeform Opus summary.

Conceptually:

```ts
interface ExecutionHandoff {
  id: HandoffID
  finalPlan: FinalPlanRef
  repositoryBaseline: RepositoryRevision

  goal: string
  hardConstraints: ConstraintRef[]
  architectureRef: ArchitectureRef

  implementationSteps: ImplementationStep[]
  requiredContracts: SectionContractRef[]
  criticalDecisions: DecisionRef[]
  knownLimitations: string[]
  validationRequirements: string[]
}
```

### 22.3 Build context

Sonnet receives a compact execution contract plus read-only access to exact Plan Memory.

It does not receive the full raw planning history by default.

### 22.4 Build permissions over Plan Memory

Build can read:

```text
FinalPlan
Architecture
Sections
Contracts
Decisions
Constraints
```

Build cannot mutate committed Plan Memory.

### 22.5 Execution freedom boundary

Sonnet may choose local implementation details that do not change approved semantics.

Replanning is required if execution would change:

- a hard constraint;
- an invariant;
- an approved interface;
- a SectionContract;
- an approved Decision;
- an explicit dependency;
- an architectural choice;
- a critical repository assumption;
- a missing design obligation that blocks implementation.

Implementation order is a default sequence; only explicit dependency/order constraints are mandatory.

### 22.6 ExecutionIssue

Build-discovered planning defects create `ExecutionIssue` records.

They do not mutate the completed Final Plan.

A subsequent `/phase-plan` creates a new PlanningRun based on the previous immutable Final Plan and reopens only affected scope.

Completed PlanningRuns are never reactivated.

### 22.7 Evidence after Build begins

The completed Final Plan preserves an Evidence Audit Snapshot from finalization time.

Expected Build edits do not retroactively invalidate the completed Final Plan.

Live planning Observation capture and Evidence freshness tracking stop when the PlanningRun completes.

### 22.8 ExecutionBinding

A lightweight `ExecutionBinding` associates the current Claude session with the active Final Plan across Build compaction/resume.

v0.1 does not implement a separate execution progress/state machine.

---

## 23. Recovery and Interruption

### 23.1 Durable unit

The durable unit is `PlanningRun`, not the Claude session.

Session lifetime and planning lifecycle are separate.

### 23.2 Identities

Phase Plan distinguishes:

```text
RepositoryIdentity
WorkspaceIdentity
ClaudeSessionID
PlanningRunID
```

A PlanningRun is bound to a stable WorkspaceIdentity.

A Claude session holds a replaceable writable binding to the PlanningRun.

### 23.3 Normal exit/crash

Closing Claude Code or crashing does not abort the PlanningRun.

The run remains `active`; the session binding may become detached/offline.

`SessionEnd` is advisory cleanup only.

### 23.4 `/resume`

Exact-session resume automatically reattaches the bound PlanningRun when workspace identity still matches.

Recovery restores Phase Plan authoritative state:

```text
active stage
active scope
HEAD Snapshot
current Proposal
Recovery Context Capsule
```

Plan Mode is **not** in this list (Amendment A1, §6.4/RI-22): documented Claude Code never restores it on the interactive resume path and `SessionStart` cannot set it. Exact-session `/resume` restores the authoritative Phase Plan binding/state when identity and workspace match; if Claude Code has not restored Plan Mode, the run remains recovered but planning continuation is guarded (fail-closed drift guards) until the user explicitly re-invokes `/phase-plan` and the existing session-scoped Plan Mode transition succeeds. The existing PlanningRun is resumed — no new run, approval, commit, or ownership transfer occurs.

### 23.5 Pending Approval

Frozen Proposals survive interruption.

They remain subject to the normal commit-time revalidation gates when later approved.

### 23.6 `/clear`

`/clear` creates a new Claude conversation and does not silently transfer writable PlanningRun ownership.

The prior run remains active/detached.

A new session may explicitly reattach/take over.

### 23.7 Fork/branch

Forked Claude sessions do not inherit writable PlanningRun ownership.

Forked conversation text is historical context, not planning authority.

### 23.8 Session ownership and fencing

One PlanningRun may have at most one writable Claude session owner at a time.

Ownership includes a monotonically increasing binding generation/fencing token.

Explicit takeover:

```text
old owner generation = 7
        ↓
user-authorized takeover
        ↓
new owner generation = 8
```

Any later mutation from generation 7 is rejected.

Phase Plan does not rely on perfect process-liveness detection.

### 23.9 Multiple PlanningRuns

Multiple independent PlanningRuns may coexist in the same repository or workspace.

A repository-wide single active-run lock is explicitly not required.

### 23.10 Worktrees

Worktrees from the same Git repository are distinct WorkspaceIdentities.

Evidence from one worktree must not be silently reused as repository-source Evidence for another.

### 23.11 Workspace disappearance

Deleting a workspace/worktree does not delete durable Plan history.

Repository-dependent planning mutations fail closed while the workspace is unavailable.

v0.1 does not silently migrate active runs to another worktree.

### 23.12 Rewind

Claude conversation rewind/checkpoint rollback does not rewind Phase Plan committed state.

Committed planning history is independent of conversation history manipulation.

### 23.13 Cross-machine scope

v0.1 guarantees durability within the same Phase Plan storage domain on the local machine.

Transparent cross-machine synchronization is not a v0.1 capability.

---

## 24. Abort Semantics

`aborted` is a terminal lifecycle state.

Abort requires explicit human authorization.

On abort:

```text
PlanningRun.lifecycle = aborted
```

Phase Plan preserves:

- Proposals;
- Approvals already made;
- PlanCommits;
- Snapshots;
- Evidence;
- audit history.

Abort invalidates writable session ownership and does not create:

- FinalPlan;
- ExecutionHandoff;
- ExecutionBinding.

Abort exits planning mode but does not automatically begin Build.

Aborted runs are never reactivated; continuing the goal requires a new PlanningRun.

---

## 25. Storage Architecture

### 25.1 Physical location

Canonical Phase Plan persistence lives under:

```text
${CLAUDE_PLUGIN_DATA}
```

Default conceptual layout:

```text
${CLAUDE_PLUGIN_DATA}/
│
├── store/
│   └── phase-plan.sqlite3
│
├── blobs/
│   └── sha256/
│
├── backups/
│   └── ...
│
└── exports/
    └── ...
```

The canonical store must not live in:

- the project repository;
- a worktree;
- `${CLAUDE_PLUGIN_ROOT}`.

### 25.2 Single global SQLite store

v0.1 uses one plugin-global SQLite database across workspaces and PlanningRuns.

Physical co-location does not imply cross-workspace logical visibility.

### 25.3 Data model

SQLite stores:

```text
immutable artifact revisions
materialized operational state
snapshots
append-only audit events
session/execution bindings
```

Event Log is an audit/provenance model, not the sole replay-based source of truth.

Snapshots are manifests of exact immutable revision refs, not full database copies.

### 25.4 Observation blobs

Large temporary Observation payloads may be stored outside SQLite in a content-addressed blob store.

Durable Evidence must retain enough provenance independently of temporary Observation blob retention.

### 25.5 Concurrency

Multiple MCP and Hook processes may access the same Store.

v0.1 uses:

```text
SQLite WAL
foreign keys
bounded busy timeout
transactional validation
expected HEAD
binding generation fencing
unique constraints
```

No custom global lock file or Phase Plan storage daemon is required.

### 25.6 Schema compatibility

Plugin version, schema version, and protocol version are distinct.

Each mutating transaction verifies store-schema compatibility.

An old plugin process is fenced from writes after a newer process migrates the Store.

### 25.7 Migration

Migrations are:

- serialized by SQLite locking;
- transactional;
- preceded by a SQLite-consistent backup;
- fail-closed on unsupported newer schema.

Automatic reverse/downgrade migrations are not supported.

### 25.8 Data retention

Workspace deletion never cascades into deletion of durable planning history.

Completed planning history has no automatic TTL in v0.1.

Temporary/unpromoted Observation data may be pruned or garbage-collected.

Plugin uninstall follows Claude Code's plugin-data lifecycle.

### 25.9 Storage domain

v0.1 assumes local single-machine filesystem storage.

Shared multi-machine SQLite over NFS/network filesystems is unsupported.

---

## 26. Runtime and SQLite Binding

### 26.1 Runtime prerequisite

Phase Plan v0.1 requires:

```text
Node.js 24.15+
```

This is an explicit prerequisite.

Claude Code installation alone does not imply that Node is available.

### 26.2 SQLite binding

v0.1 uses Node's built-in:

```text
node:sqlite
```

It does not use:

- `better-sqlite3`;
- native Node addons;
- external `sqlite3` CLI;
- Python as a runtime dependency.

### 26.3 Distribution

The Plugin ships a bundled ESM runtime artifact.

Users do not run `npm install` for runtime dependencies.

A future native Rust/Go runtime is permitted as an implementation evolution if the product later requires a zero-Node installation path, but it must preserve the same Core/Store/MCP contracts.

---

## 27. Plugin Physical Structure

Recommended v0.1 distribution layout:

```text
phase-plan/
│
├── .claude-plugin/
│   └── plugin.json
│
├── skills/
│   └── phase-plan/
│       └── SKILL.md
│
├── agents/
│   └── validator.md
│
├── hooks/
│   └── hooks.json
│
├── .mcp.json
│
└── dist/
    └── phase-plan-runtime.mjs
```

Development source remains modular even if deployment is bundled.

Recommended source boundaries:

```text
src/
│
├── core/
│   ├── state-machine/
│   ├── artifacts/
│   ├── transactions/
│   ├── synthesis/
│   ├── finalization/
│   └── invariants/
│
├── application/
│   ├── planning-service.ts
│   ├── approval-service.ts
│   ├── evidence-service.ts
│   ├── recovery-service.ts
│   └── handoff-service.ts
│
├── context/
│   └── ...
│
├── store/
│   ├── sqlite-store.ts
│   ├── migrations/
│   ├── backup.ts
│   └── blob-store.ts
│
├── claude/
│   ├── host-context.ts
│   ├── hooks/
│   ├── plan-mode.ts
│   └── hook-output.ts
│
├── mcp/
│   ├── server.ts
│   └── tools/
│
└── runtime.ts
```

Core must not import Claude Code, MCP, SQLite, or Node-specific runtime concerns.

---

## 28. Runtime Process Topology

### 28.1 Single runtime artifact

v0.1 ships one executable JS artifact:

```text
phase-plan-runtime.mjs
```

with role subcommands such as:

```text
node phase-plan-runtime.mjs mcp
node phase-plan-runtime.mjs hook SessionStart
node phase-plan-runtime.mjs hook UserPromptSubmit
node phase-plan-runtime.mjs hook PreToolUse
node phase-plan-runtime.mjs hook PostToolBatch
node phase-plan-runtime.mjs hook PostCompact
node phase-plan-runtime.mjs hook FileChanged
node phase-plan-runtime.mjs doctor
```

### 28.2 MCP process

Each Claude session gets one long-lived stdio Phase Plan MCP process.

### 28.3 Hook processes

Correctness-relevant Hooks use short-lived command processes that invoke the same runtime bundle and Store implementation.

v0.1 does not require correctness-relevant Hooks to depend on MCP-server connectivity.

### 28.4 No daemon

There is no additional:

- Phase Plan daemon;
- localhost HTTP service;
- storage service;
- background monitor.

SQLite is the local transaction coordinator.

### 28.5 Multi-session topology

```text
Claude Session S1 → MCP process ──┐
Claude Session S2 → MCP process ──┼── phase-plan.sqlite3
Claude Session S3 → MCP process ──┤
Hook processes ───────────────────┘
```

---

## 29. Claude Adapter Component Responsibilities

### 29.1 Skill

Skill responsibilities:

- `/phase-plan` entry UX;
- start/resume guidance;
- compact planning-agent protocol reminders;
- guiding Opus toward the available Phase Plan tools.

The Skill does not duplicate Core invariants or implement workflow authority.

### 29.2 Hooks

Hooks are the Claude lifecycle adapter.

Responsibilities include:

- authoritative host/session identity capture;
- Plan Mode guardrails;
- Context Capsule injection;
- Observation capture;
- FileChanged hints;
- session recovery signals;
- HostContext injection into MCP calls.

Hooks translate host events into Application commands; they do not duplicate business rules.

### 29.3 MCP Server

MCP is the model-facing Phase Plan API.

It exposes typed domain operations and delegates authority checks to Application/Core.

### 29.4 Validator Agent

The validator is a native Claude Code Opus subagent with a read-only tool surface plus `submit_validation`.

It is not a local background service.

### 29.5 Store

Store owns atomic persistence and schema migration but does not decide workflow legality.

---

## 30. HostContext and Session Authority

An MCP process's startup environment is not sufficient long-term session authority because Claude session identity may change across operations such as `/clear` while the process remains alive.

Therefore mutating MCP calls must use current host context captured by Claude Hooks.

Conceptually:

```ts
interface HostContextEnvelope {
  sessionId: string
  workspaceIdentity: WorkspaceIdentity
  toolUseId: string
  permissionMode: string
  bindingGeneration: number
  signature: string
}
```

The envelope is generated/injected by the Claude adapter, not trusted from model-provided business input.

A local plugin secret under `${CLAUDE_PLUGIN_DATA}` may be used to authenticate the envelope.

Missing/invalid HostContext causes mutating operations to fail closed.

The model cannot authoritatively supply:

```text
session_id
workspace_path
binding_generation
database_path
plugin_data_path
```

---

## 31. Planning Agent Protocol

The Planning Agent interacts with Phase Plan only through typed domain-level capabilities.

The model proposes intent.

Core owns authoritative state transitions.

The model never directly sets final database/object states.

---

## 32. MCP Tool Surface

Recommended v0.1 logical tool surface:

```text
phase_plan.start_or_resume
phase_plan.get_state
phase_plan.get_context
phase_plan.read_memory
phase_plan.list_observations
phase_plan.promote_evidence
phase_plan.revalidate_evidence
phase_plan.prepare_proposal
phase_plan.approve_proposal
phase_plan.submit_synthesis
phase_plan.submit_validation
phase_plan.request_reopen
phase_plan.request_finalization
phase_plan.handoff
phase_plan.report_execution_issue
phase_plan.takeover_run
phase_plan.abort_run
```

This is intentionally a domain-level API, not object CRUD.

---

## 33. Proposal Change Model

`prepare_proposal` accepts typed domain changes rather than arbitrary paths/SQL/database patches.

Example logical operations:

```text
ADD_DECISION
SUPERSEDE_DECISION
ADD_CONSTRAINT
SUPERSEDE_CONSTRAINT
SET_ARCHITECTURE_REVISION
SET_SECTION_REVISION
COMPLETE_SECTION
REOPEN_SECTION
ADD_OPEN_QUESTION
RESOLVE_OPEN_QUESTION
RECORD_CONFLICT_RESOLUTION
```

Core validates which change types are legal for the current stage and Proposal type.

Proposal hashes are generated by Core over canonical Proposal content.

---

## 34. Design Facts vs System Facts

Design facts require the approval pipeline.

Examples:

- Decision changes;
- constraint changes;
- Question resolution when it carries design meaning;
- Conflict resolution;
- Section/Architecture completion.

System/workflow facts may be generated deterministically by Core without user approval.

Examples:

```text
source fingerprint changed
Evidence needs validation
HEAD became stale
session fencing changed
validator reported unsupported fact
```

---

## 35. Stage Capability Model

### Discovery

Allowed conceptually:

```text
read state/context/memory
read observations
promote/revalidate Evidence
prepare Architecture work
```

### Architecture

Allowed conceptually:

```text
read
Evidence operations
Architecture checkpoint/completion/amendment proposals
formal Approval
```

### Detail

Allowed conceptually:

```text
read
Evidence operations
Section checkpoint/completion proposals
amendments
formal Approval
```

### Synthesis

Allowed conceptually:

```text
read
submit_synthesis
request_reopen
```

Ordinary design-mutation Proposal creation is unavailable.

### Validation

Main Planning Agent:

```text
read
request_reopen
request_finalization
```

Validator Agent:

```text
read
submit_validation
```

### Final

Allowed conceptually:

```text
read
formal Final Proposal Approval
```

### Handoff pending

Allowed conceptually:

```text
read
handoff
```

### Build

Allowed conceptually:

```text
read FinalPlan/Plan Memory
report_execution_issue
```

Tool hiding is a UX optimization only.

Server-side stage/capability validation is always mandatory.

---

## 36. Internal-Only Primitives

The following concepts are never model-facing tools:

```text
set_stage
set_lifecycle
set_head
create_snapshot
append_commit
create_approval
mark_proposal_approved
set_section_status
set_decision_status
set_evidence_freshness
set_binding_generation
set_execution_binding
set_permission_mode
write_database
execute_migration
complete_run
force_finalize
force_handoff
```

The model requests business actions; it does not express authoritative end states.

---

## 37. Finalization/Handoff Request Constraints

`request_finalization` does not accept bypass parameters such as:

```text
force
skip_evidence
ignore_conflicts
allow_partial
```

`handoff` likewise does not permit the model to override Final Plan authorization or runtime invariants.

These are requests to deterministic gates, not privileged write APIs.

---

## 38. Tool Error Semantics

v0.1 should expose stable machine-readable error codes such as:

```text
STALE_HEAD
STALE_SESSION_BINDING
INVALID_STAGE
CAPABILITY_NOT_AVAILABLE
PROPOSAL_NOT_FOUND
PROPOSAL_SUPERSEDED
PROPOSAL_HASH_MISMATCH
EVIDENCE_NEEDS_VALIDATION
BLOCKING_CONFLICT
BLOCKING_QUESTION
WORKSPACE_UNAVAILABLE
STORE_SCHEMA_MISMATCH
FINALIZATION_DENIED
HANDOFF_NOT_AUTHORIZED
```

Agent recovery should depend on error codes, not natural-language parsing.

---

## 39. Core Invariants

The v0.1 architecture freezes the following cross-cutting invariants.

### Planning authority

1. Claude Code owns runtime; Phase Plan owns planning workflow truth.
2. PlanningRun state is independent of conversation history.
3. Stage and artifact status are separate concepts.
4. Approved design cannot be silently edited.
5. Only PlanCommit may mutate committed Plan Memory.
6. Every PlanCommit requires authorization of an exact frozen Proposal.
7. Conversation compaction, `/clear`, fork, or rewind cannot erase or rewrite committed Plan Memory.

### Model/permission behavior

8. Claude planning tier is Opus.
9. Execution tier is Sonnet through native `opusplan` behavior.
10. Plan Mode is the host execution boundary, not the planning authority.
11. Only Final Approval + Final PlanCommit authorizes normal Plan → Build handoff.

### Context

12. HEAD Snapshot is the authoritative context-recovery source.
13. Claude compact summaries are never planning truth.
14. Context injection is a reasoning aid; correctness never depends on it succeeding.
15. Mutating operations reject stale HEAD/base Snapshot state.

### Evidence

16. Observation is automatic, temporary, and non-authoritative.
17. Evidence promotion is explicit.
18. Direct Evidence requires actual Observation provenance.
19. Evidence revisions are immutable.
20. FileChanged is a latency optimization, not the sole freshness mechanism.
21. Critical Evidence must be fresh at relevant commit/finalization gates.
22. Repository changes never silently rewrite approved design.

### Synthesis/finalization

23. Synthesis can derive execution information but cannot create new design choices.
24. Semantic Validation is isolated and read-only.
25. Validator findings cannot directly mutate Plan Memory.
26. Finalization authority belongs exclusively to deterministic Core logic.
27. Finalization is rerun after Final Approval authorization before Final PlanCommit.
28. Generated Final Markdown is not canonical state.

### Execution

29. ExecutionHandoff is a deterministic Final Plan projection.
30. Build receives read-only access to committed Plan Memory.
31. Sonnet may make local implementation choices only within approved semantic boundaries.
32. Build-discovered design defects create ExecutionIssues and require a new PlanningRun.
33. Completed PlanningRuns are never reactivated.
34. Build edits do not retroactively invalidate the completed Final Plan Evidence Audit Snapshot.

### Recovery/concurrency

35. One Claude session may bind to at most one active PlanningRun.
36. One PlanningRun may have at most one writable session owner at a time.
37. Multiple PlanningRuns may coexist in the same repository/workspace.
38. Session takeover uses generation/fencing semantics.
39. The Harness does not rely on perfect process-liveness detection.
40. Mutations are idempotent across crash/retry.
41. `/clear` and forks never silently transfer writable PlanningRun ownership.
42. Workspace identity is distinct from repository identity.

### Storage/runtime

43. Canonical Store lives under `${CLAUDE_PLUGIN_DATA}`.
44. v0.1 uses one plugin-global SQLite Store.
45. SQLite concurrency correctness relies on WAL, transactions, constraints, expected HEAD, and fencing.
46. Store schema compatibility is checked on mutation.
47. Old plugin processes fail closed after newer schema migration.
48. Workspace deletion does not delete durable planning history.
49. Node.js 24.15+ is an explicit runtime prerequisite.
50. `node:sqlite` is the v0.1 SQLite binding.
51. v0.1 requires no native Node addon or storage daemon.

### Tool authority

52. Model-facing tools are typed domain capabilities, not CRUD primitives.
53. Host identity and storage paths cannot be supplied as model authority.
54. Stage transitions are Core-derived, never directly model-set.
55. Finalization/handoff expose no force/bypass flags.
56. Abort is explicit human-authorized termination and produces no Final Plan/Build contract.

### Amendment A1 (Plan Mode recovery — see `amendments/A1-plan-mode-resume-recovery.md`)

RI-22. PlanningRun recovery and Claude permission-mode recovery are distinct operations. An exact-session resume may recover/reattach authoritative PlanningRun state even when the host does not restore Plan Mode. If the current host permission mode is not plan, no planning continuation or planning mutation is authorized until the user explicitly invokes `/phase-plan` and the documented session-scoped Plan Mode transition succeeds.

CC-11. Phase Plan never persists Claude Plan Mode into user, project, or local settings solely to survive session resume. Where the host cannot restore Plan Mode, explicit `/phase-plan` re-entry is the recovery mechanism.

---

## 40. Frozen v0.1 Non-Goals

Phase Plan v0.1 deliberately excludes:

- prompt-complexity model routing;
- automatic task classification;
- arbitrary custom main-session model switching;
- planning as subagent orchestration;
- a second planning conversation/session as the normal workflow;
- custom repository crawler;
- AST repository index;
- embeddings/vector database;
- semantic reranking infrastructure;
- Markdown as canonical storage;
- Claude conversation summary as committed memory;
- automatic replay of arbitrary commands for Evidence freshness;
- symbol-level/semantic file fingerprints;
- automatic worktree migration of an active PlanningRun;
- transparent cross-machine Plan Store synchronization;
- multi-machine shared SQLite;
- execution progress orchestration;
- automatic reverse schema migration;
- zero-runtime-dependency native binary distribution;
- model-controlled Approval, Finalization, or Handoff bypass.

---

## 41. Remaining Implementation-Specification Work

The architecture is frozen, but implementation details remain intentionally unfrozen.

These belong to the next implementation-specification phase:

```text
exact SQL DDL and indexes
schema migration v1
TypeScript interface field-level definitions
MCP JSON Schemas
Proposal canonical serialization/hash format
HostContextEnvelope canonical encoding/HMAC format
workspace identity derivation algorithm
repository identity derivation algorithm
exact hook matchers and hooks.json
exact SKILL.md text
exact validator.md prompt
Context Capsule rendering format
Observation blob retention/GC thresholds
SQLite PRAGMA values and lock timeout numbers
backup retention policy
error payload JSON schema
plugin manifest/package metadata
build/bundling toolchain
CI/release packaging
doctor/preflight checks
integration/e2e test matrix
```

These details may evolve without reopening the architecture provided they preserve the frozen invariants in this document.

---

## 42. Recommended Implementation Order

A practical implementation sequence is:

```text
1. Runtime bootstrap + doctor + Node/Claude capability preflight
2. SQLite Store + schema v1 + migrations/backups
3. Workspace/SessionBinding + fencing
4. PlanningRun + State Machine
5. Plan Memory immutable revision model
6. Proposal / Approval / PlanCommit transaction engine
7. MCP read/write domain tools
8. Plan Mode lifecycle hooks and HostContextEnvelope
9. Context Assembler + compaction recovery
10. Observation capture + Evidence promotion
11. Evidence freshness / validation gates
12. Architecture / Section workflow
13. SynthesisManifest + validator subagent
14. FinalizationGate + FinalPlan
15. ExecutionHandoff + Build read-side
16. ExecutionIssue + subsequent-run baseline support
17. Recovery/multi-session E2E matrix
18. Packaging and cross-platform release validation
```

This order builds correctness boundaries before UX refinements.

---

## 43. v0.1 Exit Gate

The first implementation should not be considered architecturally complete until the following end-to-end path works:

```text
user enters /phase-plan
    ↓
active PlanningRun created/resumed
    ↓
Claude enters Plan Mode / Opus planning tier
    ↓
repository Observations captured
    ↓
Evidence promoted where required
    ↓
Architecture proposed
    ↓
formal human Approval
    ↓
PlanCommit
    ↓
dynamic Section DAG
    ↓
section checkpoint/completion proposals
    ↓
formal approvals and immutable commits
    ↓
compaction/resume restores authoritative context
    ↓
Evidence change invalidates the relevant dependency path
    ↓
revalidation/reopen works
    ↓
SynthesisManifest generated from frozen approved state
    ↓
read-only Opus validator returns clean result
    ↓
FinalizationGate passes
    ↓
Final Plan formally approved
    ↓
Final PlanCommit
    ↓
handoff_pending
    ↓
Claude exits Plan Mode / Sonnet execution tier
    ↓
deterministic ExecutionHandoff injected
    ↓
PlanningRun completed
    ↓
Build can read but not mutate Plan Memory
```

Recovery tests must additionally prove:

```text
crash/resume during active planning
crash after Approval but before response
crash during handoff_pending
/clear without silent ownership transfer
fork without writable-run inheritance
explicit takeover with fencing
old plugin process fenced after schema migration
resume without host Plan Mode restoration (Amendment A1):
    state recovered/reattached, no new run/approval/commit,
    run revision unchanged, ordinary continuation fail-closed
    until /phase-plan re-entry restores mode to the same session
```

---

## 44. One-Sentence Definition

**Phase Plan is a Claude Code planning harness that uses Opus and native Plan Mode to progressively build an immutable, evidence-backed, user-approved design; persists that design independently from conversation state; validates it through deterministic and semantic gates; and, after Final Approval, hands the same Claude session to Sonnet for execution under a read-only Final Plan contract.**

---

## 45. Architecture Freeze

This document is the frozen Claude Code Phase Plan v0.1 architecture baseline.

Changes that alter any of the following require an explicit architecture amendment:

- authority boundaries between Claude Code, Phase Plan Core, model, validator, or Store;
- Proposal/Approval/Commit semantics;
- immutable Plan Memory guarantees;
- Evidence provenance/freshness semantics;
- synthesis/finalization authority;
- Plan → Build authorization semantics;
- session ownership/fencing semantics;
- canonical storage ownership;
- model-facing mutation boundaries;
- Core invariants listed above.

Implementation details not affecting these guarantees may evolve within v0.1 without reopening the architecture.
