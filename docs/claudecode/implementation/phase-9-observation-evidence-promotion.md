# Phase 9 Implementation Note — Observation Capture & Evidence Promotion

Status: **implemented, automated-green** (this note records the design and the
real-host facts it is grounded in; live validation is recorded separately in
`docs/claudecode/validation/phase-9-live-observation-evidence-validation.md`).

Baseline: Phase 8 frozen (`4b19018` context assembler + `10565d4` live
compaction validation). Phase 9 keeps every Phase 1–8 authority chain
untouched: Store/HEAD/SessionBinding/PlanningRun/Proposal correctness, the
Phase 8 Recovery Capsule, and the Phase 8 `context_epoch` derivation.

---

## 1. Schema v6

Migration `006-observation-evidence-foundation` (5 → 6) through the frozen
registry/backup/`BEGIN IMMEDIATE`/rollback path. New tables:

```
observations                the Observation Ledger (one immutable row per host
                            tool-result event)
evidence_artifacts          Evidence identity (ev_…), stable metadata
evidence_revisions          immutable Evidence claims (no UPDATE/DELETE)
evidence_observation_refs   immutable Observation provenance links
evidence_derived_refs       immutable exact upstream-revision links
```

Deliberately NOT created (Phase 10 owns freshness, §4/E38/E39):
`evidence_current_state`, `evidence_validation_events`,
`evidence_invalidation_events`, `file_change_events`.

Database-level guarantees:

- `observations`: `UNIQUE (run_id, tool_use_id)` is the capture idempotency
  boundary (§40/§41) — DB-enforced, not an application pre-check; CHECKs pin
  payload-hash/content-type/promotable consistency (a promotable row must be
  textual, carry a `sha256:` payload hash, and be unsanitized).
- `observations.observation_seq`: per-run, gap-free monotonic ledger order
  assigned under `BEGIN IMMEDIATE` (MAX+1 serializes writers) — deterministic
  even when wall-clock `captured_at` ties (§20).
- `evidence_revisions`: `UNIQUE (run_id, request_id)` is the promotion
  idempotency boundary (§44); `request_hash` pins the semantic payload.
- Immutability triggers (`no_update`/`no_delete`) on all five new tables
  (§6/§52/§53). DELETE is blocked too; a future GC phase would have to relax
  this explicitly via a migration.

### audit_events CHECK extension (§72)

SQLite cannot ALTER a CHECK, so `audit_events` is rebuilt inside the same
migration transaction: rows copied verbatim (explicit `event_seq` preserves
ids; AUTOINCREMENT counter follows), the immutability triggers recreated, and
the `event_type` CHECK extended with `EVIDENCE_PROMOTED`. Append-only
semantics are never relaxed. `OBSERVATION_CAPTURED` is deliberately NOT an
audit event — the Observation Ledger is itself the record.

## 2. PostToolUse host facts (§10 probe, real Claude Code 2.1.282 Windows)

Probed with a stdin-capturing hook before any implementation (both
PreToolUse and PostToolUse, headless `-p` and TUI hosts):

1. The frozen architecture's "PostToolBatch" event does NOT exist on this
   host. The equivalent is **`PostToolUse`, one tool result per event** —
   there is no batch container. §42's "one transaction per batch metadata
   publication" therefore degenerates to one transaction per capture event;
   the capture core takes exactly one event and the all-or-nothing property
   is trivially per-event. This is a documented §59 adaptation to probe facts.
2. `PostToolUse` input keys (superset): `session_id, transcript_path, cwd,
   prompt_id, permission_mode, effort, hook_event_name, tool_name,
   tool_input, tool_response, tool_use_id, duration_ms`.
3. **`tool_response` is the actual result delivered to the model** — probed
   shapes: Read `{type:"text", file:{filePath, content, numLines, startLine,
   totalLines}}`; Grep `{mode, filenames, numFiles, totalFiles}`; Glob
   `{filenames, …}`; PowerShell `{stdout, stderr, interrupted, isImage}`.
   No exit-status field exists for execution results (§38 "if host provides"
   — it does not; recorded absence).
4. `tool_use_id` (`call_…`) is stable and correlates PreToolUse ↔ PostToolUse.
5. **The execution tool on this Windows host is named `PowerShell`** with
   `{command, description}` input (the model-visible "Bash" tool surfaces as
   PowerShell). The classifier accepts both names.
6. Permission-denied tool calls produce PreToolUse only — no PostToolUse —
   so only actually-executed results are ever captured.
7. Hooks fire in `-p` (headless) mode exactly as in the TUI.

## 3. Observation model

- ID: `obs_<opaque uuid>`, server-generated; never derived from content,
  paths, timestamps, or tool input (§5). No revision model — the row IS the
  event.
- Immutable facts (§6): run/workspace/session attribution, tool name,
  `tool_use_id`, class, normalized input projection, payload reference
  (hash/size/content type), capture-time source fingerprint, repository
  revision, `promotable`, sanitizer marker, `captured_at`.
- Attribution authority (§11/§12/§13): the hook handler re-resolves the run
  through `findAttachedActiveRun(sessionId)` (SessionBinding Store) and the
  workspace record from the binding; hook-input ids other than `session_id`
  are never trusted. No attached active run → NO observation (Phase Plan is
  not a global tool logger). Capture is gated on attribution + tool class,
  never on `permission_mode == plan` (A1 recovery stays observable).
- Class mapping (§7/§8, probed): Read → `source`; Grep/Glob → `locator`;
  Bash/PowerShell → `execution`. Everything else — Edit/Write/NotebookEdit/
  AskUserQuestion/ExitPlanMode/Task/WebFetch/phase-plan MCP tools, unknown
  names, case variants — is never guessed; the hooks.json matcher
  `^(Read|Grep|Glob|Bash|PowerShell)$` pre-filters and the in-handler
  classifier is the authoritative second gate. Skips are debug-only, stdout
  stays protocol-clean (§8).
- Tools executed outside the bound workspace are skipped (paths/fingerprints
  would not be workspace-relative).

## 4. Input projection + sanitization (§14/§15)

Only a small normalized projection is persisted (raw tool input never
reaches the store), with tolerant unknown-field handling:

- Read: `{kind:"source", path, offset?, limit?}`
- Grep: `{kind:"locator", tool:"Grep", pattern, path?, glob?}`; Glob similar
- PowerShell/Bash: `{kind:"execution", command}` (hook `cwd` is the
  workspace context; the host provides no exit status to record)

Paths are stored workspace-relative with forward slashes when under the
workspace root (§74); outside paths stay as observed. Secret-shaped
projection fields (`hostcontext|entryintent|apikey|authorization|password|
secret|token|cookie`) are dropped defense-in-depth.

Sanitization boundary (§15) is conservative and documented as
defense-in-depth, NOT a secret detector:

- Detectable environment/secret-dump commands (`printenv`, bare `env`/`set`,
  `Get-ChildItem Env:`, `gci env:`, `dir env:`,
  `GetEnvironmentVariables(…)`) → the RESULT BYTES ARE NEVER PERSISTED
  (`content_type='application/x-phase-plan-omitted'`, `payload_hash` NULL,
  `promotable=0`, `sanitized='env_dump_detected'`). Command provenance is
  kept.
- Byte-level redaction of ordinary payloads is deliberately NOT attempted:
  the payload must remain the exact delivered result (§9/§80), so the only
  safe transform for a suspect result is omission. Users must not promote
  secrets into Evidence; the tool descriptions and this note say so.

## 5. Payload blob CAS (§16–§19, §43)

`${CLAUDE_PLUGIN_DATA}/blobs/sha256/<aa>/<64-hex>`; SQLite rows carry only
`payload_hash`/`payload_size`/`content_type`. Publication: bytes → sha256 →
temp file in the final directory (`wx`, fsync, close) → atomic rename.
Concurrent publishers converge on ONE canonical object (the rename is atomic
and byte-identical); both outcomes are success. Reads re-verify
`sha256(bytes) == hash` and fail closed: `OBSERVATION_BLOB_CORRUPT` /
`OBSERVATION_BLOB_MISSING` — corruption can never reach promotion. The store
never deletes; unreferenced blobs after a metadata rollback are harmless GC
candidates (§43) — no fake cross-resource atomicity.

Textuality (§19): the payload is the canonical JSON serialization of the
host-provided `tool_response` (UTF-8). Results whose payload is not textual
(Read `type != "text"`, PowerShell `isImage`) are captured as metadata only
(`content_type='application/octet-stream'`, `promotable=0`); no multimedia
blob semantics.

## 6. Idempotency (§40/§41/§44)

- Capture: same `(run_id, tool_use_id)` with identical recorded facts
  (tool name, class, input projection, payload hash, content type, sanitizer
  marker) returns the EXISTING observation; different facts →
  `OBSERVATION_CONFLICT`, fail closed. Real two-process races are tested by
  spawning actual workers against one store (§69).
- Promotion: the operation id is `promote:<HostContext.toolUseId>` — derived
  from the SIGNED context, never model input. Same id + same `request_hash`
  → the same Evidence revision (`idempotent: true`); same id + different
  semantics → `IDEMPOTENCY_CONFLICT` (Phase 6 pattern). `UNIQUE(run_id,
  request_id)` is the DB backstop. Real two-process promotion races tested
  (§70).

## 7. Fingerprint timing (§35–§37, §67)

For a source-class capture, the whole-file SHA-256 + size (+ mtime) of the
observed path is recorded AT OBSERVATION TIME into
`observations.source_fingerprint_json`. Promotion REUSES that fingerprint
verbatim — it never re-hashes the file at promotion time, so a file changed
between observation and promotion cannot rewrite recorded provenance. If the
file is unreadable at capture time the Observation still exists (§37); a
direct claim resting on fingerprintless source observations then fails
closed with `EVIDENCE_SOURCE_FINGERPRINT_UNAVAILABLE` — a fingerprint
strategy without fingerprints is never silently created. Only whole-file
SHA-256 (§54) — no AST/symbol/semantic hashes.

## 8. Evidence model

- Identity `ev_<opaque uuid>`; revisions strictly max+1, never rewritten
  (§23/§52). In Phase 9 every successful distinct promotion creates a new
  identity at revision 1 — the revision machinery (max+1, immutable history)
  exists for Phase 10's revalidation to append to. Idempotent replays return
  the same revision rather than creating another.
- Vocabulary (E25–E27): confidence `direct|derived|uncertain`; criticality
  `critical|supporting|informational` (persisted only — no freshness gate,
  §26); validation strategy `fingerprint|reobserve`.
- Kind vocabulary (§24): `source_fact|locator_fact|execution_result|
  derived_claim`. The OpenCode adapter is a parallel workstream; no shared
  EvidenceKind type was importable across adapters, so the Claude adapter
  defines exactly the directive-recommended word list (compatible semantics
  by construction, documented here).
- Provenance matrix (§32): direct ⇒ ≥1 observation, 0 derived refs; derived
  ⇒ ≥1 exact upstream revision (observations optional); uncertain ⇒ ≥1
  provenance source of either kind. No provenance-free Evidence exists.
- Scope (§34): `global | architecture` on the production surface; section
  scope is schema-representable (`scope.type='section'`) but returns
  `CAPABILITY_NOT_AVAILABLE` until the Section workflow is authoritative —
  never accepted on a string.
- `repository_context` records the observation-time coarse git HEAD
  (§75; captured via the Phase 3 fixed-argv, no-shell, bounded-timeout git
  policy — `git rev-parse HEAD` through `nodeGitRunner`, §76). Directory
  workspaces and git failures record `null` and never block capture.
- All authority fields (identity, revision, fingerprints, contexts,
  validation strategy) are SERVER-DERIVED from authoritative Observation
  rows (§29/E24). The model can only reference observation ids and exact
  upstream revisions; the request schema has no field for caller-supplied
  hashes.

### Validation-strategy server rule (§27)

Documented, explicit rule:

```
derivedFrom non-empty                                   → reobserve
confidence=direct AND every cited observation is source
  AND every one carries a capture-time fingerprint      → fingerprint
otherwise (locator/execution citations, uncertain)      → reobserve
direct pure-source basis with a missing fingerprint     → EVIDENCE_SOURCE_FINGERPRINT_UNAVAILABLE
```

Locator citations force `reobserve`: a Grep/Glob result proves WHERE
something was found, not source truth, and auto-Reading hit files would turn
Phase Plan into a repository crawler (§39). Execution provenance defaults to
`reobserve`; nothing is ever re-run automatically (§38/E30).

## 9. Promotion transaction

One `BEGIN IMMEDIATE` store transaction: idempotency lookup by
`(run_id, request_id)` → evidence identity insert (fresh `ev_` id) →
immutable revision insert (max+1) → sorted provenance links →
`EVIDENCE_PROMOTED` audit event. Payload blobs are re-verified (read + hash)
BEFORE the transaction, so corrupt/missing blobs fail promotion closed
(§66). Promotion performs NO Plan Memory write, NO HEAD mutation, NO
PlanningRun revision bump, and does NOT change `context_epoch` (E35/E36/E37,
§49/§50) — the Phase 8 epoch derivation has no Evidence input and stays
frozen.

Stage capability (§46): promotion allowed at `discovery | architecture |
detail`; `synthesis | validation | final` → `CAPABILITY_NOT_AVAILABLE` (the
finalization audit set must not grow). `list_observations` is readable at
any active stage (read-only; server-defined policy per §47).

No human Approval for promotion (§45): `promote_evidence` carries NO
`anthropic/requiresUserInteraction` meta — it records provenance, it is not
a design commitment. It still requires the hook-signed HostContext of an
attached active run (PreToolUse signs it; run-less calls are denied with
`STALE_SESSION_BINDING` at the hook and `HOST_CONTEXT_REQUIRED` at the MCP
layer). Plan mode is deliberately NOT required for promotion (record-only;
mirrors the Phase 8 read-tool rule §39), while design consequences still go
through Proposal → Approval → PlanCommit (§2/§73 — the Phase 6 engine stays
unchanged and checks no freshness gates).

## 10. MCP surface (§21/§22/§58, E41)

Exactly seven tools:

```
start_or_resume, get_state, get_context, read_memory,        (Phase 7/8)
list_observations, promote_evidence,                         (Phase 9)
approve_proposal                                             (interaction flag)
```

- `list_observations` input: `{class?, limit? (1..100, default 20),
  after? (opaque `seq:<n>` cursor), _hostContext}` — no run_id/workspace
  path/db path/session_id; authority comes from the signed session+workspace.
  Output: ledger summaries (`observation_id, observation_seq, class, tool,
  captured_at, input, payload_size, payload_hash, promotable, sanitized?,
  evidence_refs`) — never whole payloads. `evidence_refs` lists promoted
  Evidence revisions citing the observation; this IS the minimal §1 "show
  promoted Evidence references" integration. The Recovery Capsule and the
  structured context shape are untouched (§49/E42).
- No `read_observation` / `read_evidence` MCP tool: the frozen surface is
  kept; exact payload reads and `readEvidenceRevision`/`listEvidence` exist
  as application APIs (§20/§48), Evidence is deliberately NOT squeezed into
  `read_memory`'s six Plan Memory kinds, and Phase 10's `revalidate_evidence`
  can return full Evidence later.
- Not registered: `revalidate_evidence`, `prepare_proposal`, `takeover_run`,
  `abort_run` (§57/§58).

## 11. Read/write boundaries (§71)

- Observation writer: transaction-scoped primitives in `store/observations.ts`
  with exactly ONE production caller — the hook-side capture orchestrator
  `src/observations/capture.ts`. Pinned by the static import-boundary test.
- Evidence writer: `store/evidence.ts` primitives with exactly ONE
  production caller — the application domain writer
  `src/application/evidence-service.ts`. Pinned likewise.
- The model never imports or writes Store primitives; the plan-memory
  writer boundary from Phases 5–8 is unchanged.

## 12. PostToolUse failure semantics (§60)

Capture NEVER breaks the tool flow: exit 0 always. A failed capture of an
attributable evidence-capable result is fail-VISIBLE via PostToolUse
`additionalContext`:

```
Phase Plan observation capture failed (<CODE>).
error=<CODE>: …
This tool result was not recorded as a Phase Plan Observation and cannot be
promoted as Evidence. If a design decision depends on this fact, observe it
again.
```

It never claims the tool execution failed — the tool already ran; only the
provenance recording failed, and the affected result is simply not
promotable (it is not in the ledger). Unattributable events (no active run,
unsupported tool, workspace drift) stay silent. A hook-layer failure
(parse errors) degrades to exit 0 with empty stdout, like SessionStart.

## 13. What is NOT implemented (Phase 10 boundary)

No freshness state machine (`needs_validation/stale/invalidated`), no
validation/invalidation events, no FileChanged hook, no `revalidate_evidence`,
no automatic fingerprint re-checking, no derived-invalidation propagation,
no Proposal/Finalization Evidence gates (the Phase 6 engine's gate stays
absent — no "always fresh" half-implementation, §73), no GC/retention
execution (only GC-able metadata exists: evidence back-references +
`captured_at`; referenced observations must never be pruned, unpromoted ones
are eligible), no command replay, no `@file` prompt-context capture (only
real Read tool results are direct-provenance-capable — test-pinned, §55), no
subagent-prose-as-Evidence path (subagent tool results would be captured by
the same PostToolUse mechanism if the host delivers them; prose conclusions
are never provenance, §56).

## 14. Validation summary (automation)

- Node 24.21.0: typecheck + lint + build + full suite — 521 passed | 1
  skipped (71 new Phase 9 tests).
- Node 22.23.2 (dev runtime): 521 passed | 1 skipped.
- Store: 5→6 migration with real Phase 1–8 data (preserved exactly), empty
  v6 tables, history [1..6], consistent backup; injected failing 006 rolls
  back to a valid schema-5 store; schema-5 writers fenced
  (`STORE_SCHEMA_TOO_NEW`) after v6; structural v6 validation.
- Multi-process: real worker processes race capture (one observation/one
  blob; conflict loser fails closed) and promotion (one revision; drift →
  `IDEMPOTENCY_CONFLICT`).
- OpenCode adapter: 530/530 tests pass; its `tsc --noEmit` errors are
  pre-existing parallel-workstream WIP (handoff typing), untouched and
  isolated from the Claude line.
