# Phase 12 implementation note — Frozen Synthesis + Isolated Semantic Validator

Status: **PASS** (Exit Gate E1–E71). Phase 1–11 remain frozen; this phase adds
the Synthesis / Semantic Validation domain without moving any prior semantics.
Commits: `feat(claude): add synthesis and semantic validation` +
`test(claude): validate isolated semantic validator` (see git log).

## Schema v9 (`009-synthesis-validation-foundation`)

Seven immutable tables in two layers — canonical payload + exact relational
provenance (§11):

- `synthesis_inputs` (per-run `input_seq` cycle number §69, `synin_%` id,
  `base_run_revision/base_head_snapshot_id/base_head_commit_id`,
  `canonical_json`, `input_hash`) — no uniqueness on the HEAD pair: two cycles
  through the same HEAD are distinct audit units (§68);
- `synthesis_input_refs` (one current ref per artifact; FK into
  `memory_revisions` pins the exact revision) and `synthesis_input_evidence`
  (frozen freshness state per exact revision, §23);
- `synthesis_manifests` (`synm_%`, UNIQUE per input = §45 at database level,
  `request_id` = `synthesis:<toolUseId>` idempotency §44) and
  `synthesis_manifest_refs` (relational provenance; `section_contract` refs
  pin the contract embedded in that exact section revision);
- `semantic_validation_reports` (`valrep_%`, UNIQUE per manifest = §58,
  `validator_agent_json` attestation provenance, `is_clean` CORE-derived §48)
  and `semantic_validation_findings` (`vf_%` server ids, frozen vocabulary
  CHECK).

All seven get `no_update`/`no_delete` triggers. **§65 vocabulary extension**
required a REBUILD of `section_workflow_events` (SQLite cannot alter a CHECK):
the staged copies reference each other by their `_v9` names so nothing
references a table while it is dropped, and the renames rewire the FK clauses.
No backfill — §19 fail-closed: legacy `stage=synthesis` runs keep the stage
and never gain a fabricated input.

`validateSchemaV9` (§90) checks: base commit → base snapshot pairing, input
refs ⊆ base snapshot members, manifest binds the exact input hash, manifest
refs ⊆ input refs (SQL subset check incl. section_contract→section mapping),
report binds manifest+input exactly, finding refs ⊆ frozen bundle
(`json_each`/`json_extract` in SQL), clean exclusivity, trigger presence —
with a base-table guard for early-version stores.

## Validator host probe (§4) → caller attestation (§5–§7)

Real probe on Claude Code 2.1.283 (full record:
`docs/claudecode/validation/phase-12-validator-host-probe.md`). Key facts:
plugin MCP tools register as `mcp__plugin_<plugin>_<server>__<tool>`; plugin
agents spawn as `<plugin>:<agent-name>`; the Agent tool REFUSES a spawn whose
tools whitelist resolves to zero entries (fail-closed); PreToolUse hook input
carries **`agent_id`** (opaque per-spawn == background task id) and
**`agent_type`** (`<plugin>:<agent-name>`) on subagent calls and NEITHER on
main calls (100% consistent across 3 runs); after `--continue` resume main
never inherits validator identity, and a new spawn gets a new `agent_id`
while `agent_type` stays stable. Conclusion: signable caller attestation
exists → no ARCHITECTURE_BLOCKER.

Design: **HostContextEnvelopeV2** (`version: 2`, optional
`agent {agentId, agentType}`) signed only for the new capability family
(`submit_synthesis`, `submit_validation`, `request_reopen`); the ten Phase
7–11 tools keep byte-identical V1 envelopes (§7). The hook parses
`agent_id`/`agent_type` from real host input (parse.ts); the envelope is
HMAC-signed with the host secret and verified in the MCP handler — a model
can neither forge the signature nor inject hook input.

`agents/validator.md` (§8/§9): `model: opus`, isolated, tools whitelist =
`get_context`, `read_memory`, `submit_validation` (probe-verified names);
prompt authority = the frozen bundle only; submit exactly once.

## SynthesisInput (§13–§27)

`SynthesisInputV1` canonical payload: version, runId, baseRunRevision,
baseHeadSnapshot, baseHeadCommit, architecture/sections/decisions/constraints
(exact content projections), sectionContracts (embedded contract_json),
resolvedQuestions/resolvedConflicts (status filter §16), relevantEvidence
(frozen `{revision, confidence, criticality, strategy, state,
lastValidationEventSeq, claim}` §23). `synthesisInputHash` canonicalizes
internally so presentation order never changes the hash (§106); server ids
are columns, never payload (§106 "ID determinism").

**Creation point (§18)**: `createSynthesisInputAtDetailCompletionInTx` runs
inside the LAST Section completion transaction after the engine's
active-clear/DETAIL_COMPLETE bump — no extra run bump (§84). It rebuilds the
design world from the resulting snapshot members and runs §21 reachability:

1. every commit whose proposal changes introduced a current (kind, id,
   result-revision) ref contributes its `requiredEvidence`;
2. every completion proposal contributes explicitly;
3. recursive exact upstream closure via `evidence_derived_refs`.

No claims scanning, no scope inference, no "latest" (§22). Then the §24 gate:
`evaluateCriticalEvidenceGateInTx(recheck: true)` over the design-reachable
critical refs — failure throws and the WHOLE completion rolls back, so stage
synthesis never lacks an input (test: §24 stale critical evidence fails the
last completion closed).

## submit_synthesis (§41–§45/§78/§84–§86/§89)

One write transaction, in order: idempotency replay (`synthesis:<toolUseId}`,
content-hash compare, IDEMPOTENCY_CONFLICT) → run load/binding/lifecycle →
validator-caller reject (VALIDATOR_MUTATION_FORBIDDEN) → plan-mode required →
frozen input reload (SYNTHESIS_INPUT_REQUIRED for legacy runs) → **§45
already-submitted check BEFORE the stage gate** (a racing loser must see
SYNTHESIS_ALREADY_SUBMITTED, not the stage the winner moved to — §86) → stage
gate (CAPABILITY_NOT_AVAILABLE) → identity/hash checks → HEAD match
(SYNTHESIS_STALE §26) → §78 gate-time critical-Evidence recheck (failures
persist real freshness facts; no manifest; stage stays synthesis) → manifest
validation (SYNTHESIS_MANIFEST_INVALID; the model's echoed input identity is
overridden with the authoritative frozen values before hashing) → ref
membership (SYNTHESIS_REF_INVALID) → insert + the single
synthesis→validation bump. No HEAD move, no PlanCommit, no Approval.

## SemanticValidationReport (§46–§58/§79/§87–§88)

`SemanticValidationReportV1` hash payload = input/manifest identity + sorted
canonical findings — report id, timestamps, and finding ids excluded (§50/§51).
`validateValidationFindings` enforces the frozen vocabulary (§47), `[clean]`
or ≥1 non-clean (§48 — `isClean` derived, never submitted), no-subject clean.
Ref membership against the frozen bundle → VALIDATION_REPORT_INVALID.
Caller fence: envelope `agent.agentType === "phase-plan:validator"` else
VALIDATOR_CALLER_REQUIRED — checked before everything else, so a main call
with a perfect payload still fails (§98). Stage/staleness: stage must be
validation, the submitted manifest must be the current input's manifest, and
HEAD must still match the base — any drift ⇒ VALIDATION_STALE (§88 reopen-vs-
validation race). `request_id = validation:<toolUseId>` idempotency; UNIQUE
per manifest (§58/§87 loser VALIDATION_ALREADY_SUBMITTED). The report NEVER
moves stage, run revision, or HEAD (§56).

## request_reopen (§59–§67)

Main-only (validator ⇒ VALIDATOR_MUTATION_FORBIDDEN §61); origins
synthesis/validation only; target detail|architecture; reason required;
finding_ids validation-stage-only. Derivation (§63/§64): architecture ⇒ ALL
completed → `ARCHITECTURE_REVIEW_REQUIRED`; synthesis ⇒ ALL completed →
`SYNTHESIS_REVIEW_REQUIRED` (fail-closed, no finding authority yet);
validation with finding ids ⇒ resolve exact Section refs from the findings
(unknown id ⇒ REOPEN_REQUEST_INVALID), then the named sections + DAG
downstream ∩ completed; validation without (or refs naming no section) ⇒ ALL.
Events extend the Phase 11 vocabulary (§65); completed→needs_review only —
no automatic needs_review→open (§66); re-completion re-binds the same exact
revision. Stage moves via the frozen matrix (`REOPEN_DETAIL`/`REOPEN_ARCHITECTURE`),
run revision +1 exactly once, HEAD and the historical input/manifest/report
untouched (§62/§67/§85). New cycle ⇒ new input (§68).

## Context/epoch v3 (§28–§34/§71–§72/§105)

`CONTEXT_MODEL_VERSION = 3`, epoch `context-epoch:v3`; new context fields
`synthesis` (input id/hash/base HEAD/ref counts §29), `synthesisManifest`,
`semanticValidation` (report id/hash/isClean/kind counts). Epoch inputs gain
the three identity pairs (§30) — submit_synthesis/submit_validation/
request_reopen are all visible; raw Evidence freshness still excluded.
Capsule v3 header + three segments (`Synthesis:`, `Synthesis manifest:`,
`Semantic validation:` — clean shows "Finalization not yet performed." §72,
non-clean shows kind counts §71); synthesis/manifest/validation segments are
required when present. `get_context(detail=validation)` (§32–§34) returns the
frozen bundle projections (input canonical + manifest canonical + report
canonical with finding rows) at stage synthesis/validation only — readable by
main AND validator (authority lives in submit_validation's attestation, not
read permissions).

## Capability matrix (§73–§77/§95)

13-tool surface. At synthesis/validation: prepare_proposal (existing stage
fall-through), select_section (detail-only fence), promote/revalidate/
approve (new `assertMainCapabilityForStage` → CAPABILITY_NOT_AVAILABLE) are
shut off for main; submit_synthesis is plan-mode-gated and synthesis-only;
submit_validation is validator-only; request_reopen is main-only from
synthesis/validation. No request_finalization/handoff/takeover/abort tools.

## Legacy schema-8 synthesis handling (§19/§70/§110)

Migration fabricates nothing. A legacy run at stage=synthesis has no input ⇒
`submit_synthesis` → SYNTHESIS_INPUT_REQUIRED; `request_reopen(detail)` works
(synthesis-stage policy marks all completed sections needs_review); the
re-completion chain creates a genuine Phase-12 input. Proven by test (drop
synthesis tables, re-migrate, assert) and by the REAL Phase 11 legacy run in
the live store (kept stage=synthesis, no input, untouched).

## Phase 13 boundary

No FinalizationGate, no final_plan/finalization/handoff tables, no
validation→final transition, no `VALIDATION_CLEAN` use. A clean report says
so explicitly in the capsule and tool output ("finalization is NOT performed
by this phase"). `report_execution_issue`/`takeover_run`/`abort_run` remain
unexposed.

## Deviations (documented, none semantic)

1. **§43 order**: the §45 already-submitted check runs BEFORE the stage gate
   (after input reload) so a concurrent loser gets SYNTHESIS_ALREADY_SUBMITTED
   (§86 wins over the §43 listing order).
2. **Idempotency placement**: both submissions check the operation replay
   before all stage gates (replay must return the recorded result even though
   the stage has moved — §44/§57 "same stage result").
3. **§78 bridge**: a failed submit_synthesis evidence gate lets the Phase 11
   Evidence→Section review bridge fire inside the same transaction (consistent
   with Phase 11 semantics; §78 only requires no manifest + stage unchanged).
4. **Probe C recording**: this environment routes model tiers through a proxy
   (`ANTHROPIC_DEFAULT_OPUS_MODEL` = glm-5.3-flash-cc[1M]); `model: opus`
   frontmatter was honored (the spawn requires a fully parsed definition and
   ran under the opus-alias resolution), but the exact served model string of
   the background subagent is not persisted by the host — recorded as an
   environment limitation, not a host gap.
