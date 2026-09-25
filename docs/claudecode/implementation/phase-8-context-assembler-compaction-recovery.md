# Phase 8 Implementation Note — Context Assembler & Compaction Recovery

Status: IMPLEMENTED (Claude Code adapter, `@switchboard/claude-code`)
Baseline: Phase 7 FROZEN / PASS (`a5130ce`); this phase adds no schema migration.

---

## 1. What Phase 8 adds

Phase 8 closes the gap between **Plan Memory (authority)** and **Claude's context
(what the model currently sees)**. It implements, and nothing more:

- the authoritative context projection (`src/context/`),
- the Recovery Context Capsule injected by SessionStart,
- the normal-turn delta-context foundation (epoch marker),
- compaction recovery,
- the read-side MCP tools `get_context` and `read_memory`.

It deliberately does NOT touch Observation/Evidence (no observations, evidence,
PostToolBatch, FileChanged, blob CAS, fingerprint logic — directive §49).

Core principle (frozen architecture §1): `Plan Memory determines correctness.
Claude context determines what the model currently sees.` Context is a
**projection, not authority**. A missing/stale/wrong injected context can
degrade reasoning quality but can never authorize a mutation — every mutation
path continues to verify SessionBinding generation, PlanningRun revision, HEAD
Snapshot, Proposal hash, and the hook-signed HostContext, exactly as frozen in
Phases 3–7.

## 2. Context layers L0–L5 (structured, not six markdown sections)

`src/context/types.ts` defines one structured model (`PhasePlanContext`,
`version: 1`) whose fields map to the frozen logical layers:

| Layer | Frozen name | Representation |
| --- | --- | --- |
| L0 | Planning Protocol | `protocol` — static identity `{ name: "phase-plan", entry: "/phase-plan", contextModelVersion: 1 }` |
| L1 | Run State | `run` (id/lifecycle/stage/revision/goal) + `head` (commitId/snapshotId pair) |
| L2 | Global Committed Memory | `globalMemory.hardConstraints`, `globalMemory.architecture` |
| L3 | Active Scope Memory | `globalMemory.sections` (identities) + `activeScope` (see §9) |
| L4 | Working Context | `working.awaitingProposal` |
| L5 | Available Operations | `operations` |

Layering rule (directive §3): the **core context modules are pure** — they
import no Claude hooks, no MCP SDK, no `node:sqlite`, no filesystem, no
`process.env`. The **Application layer** provides the authoritative read model
(`src/application/context-read-model.ts`) behind the `ContextSource` port; the
Context layer only assembles/projects. The read model delegates exclusively to
the frozen Phase 5/6 read APIs (`getPlanningRunRecord`, `getHeadCommitRecord`,
`getHeadSnapshotRecord`, `readMemoryRevisionRecord`, `getAwaitingProposalRecord`)
— no second raw-SQL Plan Memory reader exists (§26). The import-boundary test
was refined accordingly: write primitives remain engine-only; the read model is
the single sanctioned read-side consumer of `store/plan-memory.ts`.

## 3. Structured Context before rendering (§16)

`assembleContext(source, runId)` first produces the structured
`PhasePlanContext`; `buildRecoveryCapsule(context)` renders it afterwards. The
markdown capsule is never an internal authority. The assembler:

- fails with `RUN_NOT_FOUND` for a missing run and `STORE_SCHEMA_INVALID` when
  the HEAD Snapshot references a missing revision (corruption is never
  projected silently),
- performs **no mutation** (E22 — pinned by tests counting all Plan Memory
  tables before/after),
- records an internal `sourceTrace` (run revision, HEAD pair, snapshot ref
  count, awaiting proposal revision) for tests/debug and later Evidence/
  Finalization audit (§44); it contains only planning-domain facts.

## 4. context_epoch derivation (§5/§6/§36–§38)

`context_epoch = sha256(canonicalJson({ runId, runRevision, headCommitId,
headSnapshotId, awaitingProposal{id,revision,hash}|null, activeScope|null }))`
(full 64-hex, `src/context/epoch.ts`).

- Deterministic: same Store state ⇒ same epoch; wall clock, random UUIDs,
  conversation turn numbers, and Claude compact counts are not inputs.
- Changes exactly when visible authoritative planning state changes:
  HEAD `null → C1/S1`, `C1/S1 → C2/S2`, no proposal → awaiting P1, awaiting →
  approved (HEAD moves), awaiting → rejected/superseded (awaiting → null/next).
  All pinned by tests.
- **SessionBinding generation is deliberately excluded** (§38 recommendation):
  the binding is an authorization fence, not planning knowledge; HostContext
  separately protects ownership. Re-attach (generation +1) leaves the epoch
  unchanged — test-pinned.
- **Not a mutation gate** (§6/§35): the epoch is an optimization/stale-context
  hint. A stale epoch supplied by the model cannot override any fence; read
  tools simply return the CURRENT epoch. No `STALE_CONTEXT_EPOCH` error exists
  in Phase 8.

## 5. Committed-memory projection (§9–§15)

`src/context/projection.ts`, all ordering explicit (artifact id within kind —
never SQLite natural order):

- **Hard constraints**: only `severity = hard` AND `status = active` at the
  snapshot's chosen revisions (§12). Historical revisions, conversation text,
  and uncommitted proposal changes are never mixed in.
- **Architecture**: the at-most-one architecture revision, carried via its
  **frozen persisted `compact_projection`** — never re-summarized by a model
  or re-derived (§9, E8).
- **Sections**: identity only (ref + title), ordered by artifact id. The
  section detail (including the frozen `SectionContract`) is reachable through
  `read_memory detail=contract` (§10/§25).
- **Blocking questions**: `status = open ∧ blocking = true` (committed HEAD
  authority, §13).
- **Blocking conflicts**: `status = open ∧ severity = hard` — deliberately the
  same rule the Phase 6 engine uses for `BLOCKING_CONFLICT` (§58), so the
  context's notion of "blocking" never diverges from the engine's.
- Determinism: two assemblies of identical Store state serialize
  byte-identically (E14/E33, test-pinned via `JSON.stringify` equality).

## 6. Proposal isolation (§14, E10/E11)

The awaiting proposal is represented **only** in `working.awaitingProposal`
(id, revision, hash, type, scope, title, summary). Its candidate changes never
appear in `globalMemory`. Test: a prepared checkpoint adding a constraint/
decision leaves `globalMemory` untouched; after approval the same facts appear
as committed memory and the proposal region empties.

## 7. Active scope (§8/§10/§11)

`activeScope` is typed `null` and rendered as `Active scope: none`. Phase 4
never persisted `activeWork`/`activeSection`; Phase 8 does not invent
authoritative mutable active-scope state and never guesses a section (not
first/latest/alphabetical). Recorded as an **intentional Phase-12 workflow
deferral**: the Section workflow phase will establish active Section semantics.
Consequently `dependencyContracts = []` in Phase 8 (§11 — no guessing); the
`read_memory` API still supports explicit section reads including
`detail=contract`.

## 8. Recovery Capsule rendering (§17)

`src/context/render.ts` builds named segments; `src/context/capsule.ts` applies
the budget and joins them in the fixed display order:

```
[Phase Plan Recovery v1]

Run:           id / lifecycle / stage / revision / goal
HEAD:          commit / snapshot / context_epoch
Hard constraints:  - <id>@<rev> (<source>): <statement>
Approved architecture: <id>@<rev> + frozen compact projection
Active scope:  none
Blocking:      questions / conflicts
Awaiting proposal: id/revision/hash/type/scope/title/summary
Committed sections: - <id>@<rev>: <title>
Available Phase Plan operations: - <op>
```

All segment builders are deterministic; empty lists render explicit `(none)`
markers so the shape is stable. Rendering never contains secrets (§45): no
HostContext tokens, signing material, OAuth/API keys, database paths, or other
sessions' ids — the input type carries planning-domain state only.

## 9. Budget policy (§18/§19, E15/E16)

`RECOVERY_CAPSULE_MAX_CHARS = 12_000` (documented constant; a rendering budget
only — it gates nothing else). Priority classes:

- **P0 (required, never dropped)**: run identity/stage/goal, HEAD + epoch,
  hard constraints, blocking questions/conflicts, awaiting proposal, active-
  scope line, available operations.
- **P1 (best effort, explicit omission)**: approved architecture projection,
  committed section identities.

If P0 alone exceeds the budget the capsule fails closed with
`CONTEXT_BUDGET_EXCEEDED` rather than emitting a misleading capsule. P1
segments are dropped only with an explicit
`Budget note: omitted due to capsule budget: …` marker (`truncated: true`).
No individual line is ever cut mid-content; a hard constraint or blocking
condition can never be silently removed (E16). Tests pin both behaviors,
including a realistic §47 case: an oversized run goal overflows P0 and
SessionStart surfaces the failure marker.

## 10. Available operations (§27/§28)

L5 reflects current state, never the tool list and never unimplemented tools:
`get_state`, `get_context`, `read_memory`, `start_or_resume` always;
`approve_proposal` appended exactly while a proposal is awaiting approval.
`promote_evidence` / `prepare_proposal` / takeover / abort are never
advertised. Presentation is not authority: the server independently
revalidates every call (§28) — unchanged from Phase 7.

## 11. MCP read tools (§20–§25, §39–§42)

Surface is now exactly five tools (E31, pinned by tests):
`start_or_resume`, `get_state`, `get_context`, `read_memory`,
`approve_proposal`.

**`get_context`** — read-only. Input `{ detail?: "recovery" | "current" }` +
reserved `_hostContext`. Returns `{ status: "ok", context_epoch, context:
<PhasePlanContext>, recoveryCapsule? }` — the capsule text only with
`detail: "recovery"`. Never returns raw DB rows, host-context secrets, all
historical proposals, or other sessions' ids (§22). Model-supplied
`run_id`/workspace/db path/snapshot override is rejected by the exact business
schema (`MCP_INPUT_INVALID`).

**`read_memory`** — read-only. Input `{ kind, id, revision, detail? }` +
reserved `_hostContext`; detail ∈ `identity | summary | full | contract`
(default `summary`). Exact immutable MemoryRefs only: no
`latest=true`/`current=true`/by-title/fuzzy path exists, and `run_id` is not
model input (§24). `detail=contract` returns the frozen `SectionContract` for
sections and `CAPABILITY_NOT_AVAILABLE` for every other kind (§25). A miss is
`MEMORY_REVISION_NOT_FOUND` (reused per §46). New error codes
`CONTEXT_NOT_AVAILABLE`, `CONTEXT_BUDGET_EXCEEDED`, `MEMORY_REF_INVALID`,
`MEMORY_DETAIL_UNAVAILABLE` were added to the error vocabulary (all mapped to
the domain exit code).

**Authority/scoping (§21/§39/§40/§41).** Both tools use the same security
pattern as `get_state`: a hook-signed HostContext (HMAC, tool binding,
business-input hash) is mandatory; the run is resolved from the **signed
session + workspace scope** re-read from the Store (`resolveCurrentRun`) —
attached-active preferred, the session's own detached-active run still
readable. Read tools do NOT require `permission_mode = plan`, so a run
recovered under A1 stays readable while mode restoration is pending; workspace/
session scope is still verified. Because resolution is session-scoped:

- `/clear` (new session, no bindings) yields `{ status: "no_active_run" }` —
  the prior session's run is unreachable (E29);
- read tools can never auto-select or auto-takeover another session's run
  (RUN_SELECTION_REQUIRED semantics are unchanged and mutation-only) (E30).

## 12. SessionStart integration (§29, §47, E17–E19)

`handleSessionStart` upgrades the Phase 7 minimal `run=/stage=/head=` marker to
the full deterministic Recovery Capsule whenever the session owns an attached
active run — which covers `startup`, `resume`, and `compact` sources. The
exact A1 sentences from Phase 7 are preserved verbatim and appended when
`permission_mode != plan`: "Phase Plan run recovered." + "Claude Plan Mode must
be restored by invoking /phase-plan." (E19; the Phase 7 A1 regression suite
stays green with only the marker-format pins updated).

Failure policy (§47): SessionStart cannot block the host, so capsule
construction failures are **fail-visible** — the hook injects
`CONTEXT_RECOVERY_FAILED` + the error code + "Do not continue planning on
stale context; invoke /phase-plan." instead of a capsule. (Store-level
breakage additionally fails the later UserPromptSubmit/PreToolUse guards
closed, and the §19 budget itself fails closed — both test-pinned.) Context
injection never mutates the Store (E22/§48; schema stays v5).

## 13. Compaction semantics (§30/§31, E20/E21)

Confirmed against the current host documentation: SessionStart fires again
after compaction with `source=compact` (the host also has separate
PreCompact/PostCompact events — deliberately NOT wired; `PostCompact` remains
in the runtime's reserved-hook list, so the same capsule can never be injected
twice). The `compact` source flows through the same handler; a test proves
`compact` and `startup` inject byte-identical capsules for identical Store
state.

The Claude compact summary is treated as conversation context only: it is
**never** written to Plan Memory, Proposals, Snapshots, or Commits, and it is
never an input to the assembler (the assembler's signature accepts no
conversation data at all). Recovery always rebuilds from HEAD + run state
(E20), which is why two different "compact summaries" over the same Store
state must — and do — project identical context (§53 test).

## 14. Normal-turn delta context (§34/§35)

Minimal foundation: `UserPromptSubmit` injects a short marker on ordinary
prompts while an active run is attached and the session is in plan mode:

```
Phase Plan context epoch: <E>
Use phase_plan.get_context if context appears stale.
```

The full capsule is never injected per-turn. The marker is computed from the
cheap epoch inputs only (run row, HEAD pair, awaiting proposal — no snapshot
expansion). No `lastObservedContextEpoch` state is tracked and no session-local
variable is load-bearing. Entry prompts (`/phase-plan` or the entry marker) and
the drift/block paths keep their exact Phase 7 behavior; the marker rides only
on allowed plan-mode prompts.

## 15. Why schema remains v5

The Recovery Capsule is **not** a canonical durable artifact: it is
deterministically rebuildable from PlanningRun + HEAD Commit/Snapshot + Plan
Memory revisions + Proposal state + SessionBinding (§4). Accordingly no
`context_capsules` / `conversation_context` / `compact_summary` tables exist,
`context_epoch` is not persisted (it is derived), and `PRAGMA user_version`
stays 5. Tests assert schema v5 and zero row-count deltas across `get_context`,
`read_memory`, SessionStart, and compaction recovery.

## 16. Phase 9 boundary

Phase 8 does not add: observations, evidence, evidence_validation, PostToolBatch
capture, FileChanged, blob CAS, fingerprint logic, Context Capsule persistence,
prepare_proposal, takeover_run, abort_run, Section completion, Synthesis,
Validator, Finalization, or handoff. The `sourceTrace` field is the seam later
Evidence/Finalization audit will consume.

## 17. Test map (directive §50–§57)

- `test/context-core.test.ts` — empty-HEAD baseline, determinism, epoch
  transitions (HEAD ×2, awaiting, rejected, binding-excluded), projection
  filters/ordering, architecture verbatim projection, sections, blocking
  rules, historical-HEAD isolation (§54), proposal isolation (§55), read-model
  exactness/cross-run rejection (§51), no-mutation (§48).
- `test/context-capsule.test.ts` — stable §17 shape, byte-identical rendering,
  budget priority (P0 kept / P1 explicit omission), `CONTEXT_BUDGET_EXCEEDED`.
- `test/mcp-phase8.test.ts` — get_context/read_memory contract, session
  scoping (/clear §56, no-takeover §41), read-only HostContext without plan
  mode (§39), exact-revision semantics, contract capability error, six-kind ×
  detail matrix, schema v5 + no mutation, five-tool surface (§42).
- `test/context-recovery-hooks.test.ts` — SessionStart startup/resume/compact
  capsule (§52), A1 wording, §47 fail-visible marker, UserPromptSubmit epoch
  marker (§34) with entry/drift Phase 7 behavior preserved.
- Updated pins: `mcp-phase7.test.ts` + `mcp-bootstrap.test.ts` (five-tool
  surface), `hook-handlers.test.ts` (capsule marker format, marker on allowed
  prompts), `amendment-a1-recovery.test.ts` (A1 chain unchanged; plan-mode
  continuation now carries the marker), `import-boundary.test.ts` (read-side
  carve-out with write-primitive exclusivity intact).
