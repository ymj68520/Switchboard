# Phase 9 Live-Host Validation — Real Observation Capture & Evidence Promotion (§79/§80)

Status: **PASS** — every gate below was executed against a real, authenticated,
interactive Claude Code host; no settings workarounds, no debug mutation tools,
no hand-written capability proofs.

Host: Claude Code **2.1.282**, Windows 10.0.19044, Node **24.21.0** first on
PATH (launcher environment; see §9 for the Node-22 counter-test), auth
`oauth_token`. Plugin: inline
`--plugin-dir D:\Programing\agent\plan-plugin\adapters\claude-code` (dist built
from the committed Phase 9 tree, commit `4493eed`).
Workspace: `C:\Users\Administrator\phase9-live-ws` (registered in Phase 7;
store already at schema 5 before this phase).
Store: the host-managed inline-plugin root
`C:\Users\Administrator\.claude\plugins\data\phase-plan-inline\store\phase-plan.sqlite3`
+ blob CAS under `...\phase-plan-inline\blobs\sha256\` (the host overrides
`CLAUDE_PLUGIN_DATA` for plugin children — Phase 7 host fact).
Two interactive sessions were driven in the same workspace:

- **Session A** — debug `debug.log`, session id `fe149f44-feae-453e-a0dd-936735da3f60`,
  run `plan_3c308b04-1496-4dda-8f1f-a77698a80a0e` (goal “Phase 9 live
  observation evidence validation”). Full capture → list → promote chain.
- **Session B** — debug `debug4.log`, session id `ac4b3b94-6889-4762-b470-18eb45d4fae4`,
  run `plan_fe067714-5980-4b25-906a-cd3ec6fa40ba` (goal “Phase 9 locator
  capture via Grep”). Locator-class captures + multi-session fencing.

(`debug2.log`/`debug3.log` are two intermediate launches documented in §9;
they validated the Node-version fail-closed gate and the host's MCP backoff.)

Fixture: `phase9-live-source.txt` (71 bytes) written BEFORE the session; its
whole-file sha256 was pre-computed independently as
`14622e5b04df52ababe5a825d763adbc247c33fb160978bf397e46ed536855d3` and only
compared afterwards. `nested/nested-note.txt` (26 bytes, marker `OBS9 hit`);
`latest` — a harmless symlink used for one PowerShell probe.

## 1. Plugin load + live schema migration (L1-equivalent)

- `hooks.json` registered all seven events (PostToolUse included, matcher
  `^(Read|Grep|Glob|Bash|PowerShell)$`); MCP connected: `mcp server
  'phase-plan' v0.1.0 ready on stdio (7 tools)` (debug4.log line 126).
- The real store migrated **5 → 6 on plugin load**: `PRAGMA user_version` = 6,
  `schema_migrations` history rows 1..6 ending `observation-evidence-foundation`,
  `observations`/`evidence_artifacts` created empty, all Phase 2–8 rows
  preserved (planning_runs 2 at that point).

## 2. `/phase-plan` entry (Session A)

Expansion → namespaced `phase-plan:phase-plan` → signed EntryIntent → PreToolUse
ask (“Enter Phase Plan planning mode … not a design approval”) →
PermissionRequest hook allow with `setMode(plan, destination=session)` →
`start_or_resume` completed (30 ms) → run `plan_3c308b04…` created at
discovery, revision 1. Status line: **plan mode on**.

## 3. Automatic capture — one row per PostToolUse, exact attribution

The model worked freely (its own curiosity read the workspace and even its own
debug log). Result: **6 capturable tool dispatches → exactly 6 observation
rows**, monotonic `observation_seq` 1..6, zero extra, zero missing, each with
the host's exact `tool_use_id`:

| seq | class | tool | host toolUseId (debug.log `[Stall]` lines) |
| --- | --- | --- | --- |
| 1 | execution | PowerShell | `call_3309d038115c4a17a6c9176a` |
| 2 | source | Read | `call_dd06973f9a1f44ae9f99d72e` |
| 3 | execution | PowerShell | `call_01aac32957554efc885adfed` |
| 4 | source | Read | `call_7699590e9c7e467fb347688f` |
| 5 | source | Read | `call_e685e99efa824a099c450f36` |
| 6 | execution | PowerShell | `call_aebaed83ead84e6db0cbae58` |

- Projections: `{kind:"source",path:"phase9-live-source.txt"}`,
  `{kind:"source",path:"debug.log",limit:40}` (partial read of a 52,216-byte
  file), `{kind:"execution",command:"Get-ChildItem -Force | …"}`, etc.
- **Payload integrity**: for all 11 rows across both sessions the blob under
  `blobs/sha256/<aa>/<64hex>` re-hashes to exactly `payload_hash`, and
  `payload_size` equals the actual byte length.
- **Byte-level fidelity (the §80 gate)**: observation 2's payload is the
  canonical JSON of the exact `tool_response` the host delivered to the model;
  its `file.content` is **byte-identical** to the on-disk file, and the
  capture-time `source_fingerprint.sha256` equals the pre-computed
  `14622e5b…` above. Observation 4 proves whole-file fingerprinting at capture
  time even for a `limit:40` partial read (fingerprint size = 52,216, not the
  delivered slice).
- Execution payloads carry the real `stdout` (dir listing text the model later
  quoted) and confirm the probe fact: the host's PowerShell result has **no
  exit-status field** (`interrupted/isImage/stderr/stdout` only).
- Denied/permission-blocked calls produced no PostToolUse and no rows;
  unattributable events would be silently dropped (no active run → no
  Observation) — the gate is attribution + class, never `permission_mode`.

## 4. `list_observations` (live)

The model called it spontaneously, twice. Debug log: PreToolUse hook signed
`_hostContext` (business input `{limit:50}` hashed into the token),
`Tool 'list_observations' completed successfully` (77 ms / 47 ms). The model's
on-screen reading matched the store exactly: “All 6 tool calls captured 1:1
(seq 5–6 arrived after the first query). Payload hashes are stable across
repeated queries for seq 1–4.” Summaries only — class/seq/hash/size/projection
and `evidence_refs`; **no payload text is reachable from the list output**
(payloads require `read`-level access, and even that never leaves the
verified blob path).

## 5. `promote_evidence` (live) — five promotions covering all four kinds

Each promotion was an ordinary host permission dialog (read-only surface, no
`requiresUserInteraction`), completed in 35–48 ms. `request_id` for each call
is `promote:<host toolUseId>` from the signed HostContext:

| evidence | kind | observation basis | confidence | strategy |
| --- | --- | --- | --- | --- |
| `ev_b491f202…` | source_fact | obs 2 (Read source) | direct/critical | **fingerprint** |
| `ev_e95ce77d…` | source_fact | obs 5 (Read nested-note) | direct/supporting | **fingerprint** |
| `ev_26422e27…` | locator_fact | obs 6 (PowerShell symlink probe) | direct/supporting | reobserve |
| `ev_faef0c43…` | execution_result | obs 1 (PowerShell listing) | direct/supporting | reobserve |
| `ev_0d15e825…` | derived_claim | derived from upstream evidences | derived/critical | reobserve |

- Server-derived authority held: fingerprints/contexts/strategies came from
  the observation rows; the model's input surface is exactly
  `claim/kind/scope/confidence/criticality/observation_refs` (the permission
  dialogs show precisely those fields — no forgeable hash fields exist).
- Audit: `EVIDENCE_PROMOTED` rows = 5, one per promotion; capture wrote **no**
  audit rows; the pre-existing audit history (PLAN_COMMITTED 2,
  PROPOSAL_PREPARED 4) is intact after the in-place CHECK rebuild.
- Same-operation idempotent replay and same-toolUse/different-semantics
  `IDEMPOTENCY_CONFLICT` are enforced by the DB (`UNIQUE(run_id,request_id)` +
  `request_hash` pin) and covered by E32/E33 unit tests and the real
  multi-process worker tests (E45/E46); the live model happened to issue five
  *distinct* operations, so no replay occurred on host — documented as
  test-covered, not live-repeated.

## 6. No-mutation invariants (E35/E36/E37/§72)

Pre/post table counts identical: plan_heads 2, plan_commits 2,
plan_snapshots 2, proposals 4, approvals 2. The live run stayed at
**revision 1, discovery, active** — promotion did not touch `plan_heads`,
did not bump `planning_runs.revision`, and no freshness machinery exists to
mutate (`context_epoch` unchanged; no evidence-state tables).

## 7. Session B — locator class + multi-session fencing

- `start_or_resume` for a workspace whose other run is still active returned
  **`selection_required`**: “This workspace has active planning runs owned by
  other sessions. Phase Plan never attaches to them automatically … takeover
  is a separate human-authorized operation (TAKEOVER_REQUIRED), or pass
  action=start_new …”. The model surfaced the choice; the user selected
  “Start new run”; the second call created `plan_fe067714…`. The
  authority boundary (no cross-session auto-attach) is live-validated.
- Captures: Glob ×2 and Grep ×1 → **locator** (e.g.
  `{"kind":"locator","path":".","pattern":"OBS9","tool":"Grep"}`), Read ×2 →
  source; payload hashes re-verified 5/5; the Grep payload contains the
  actual match output (the `nested-note` hit). With Session A's PowerShell
  rows, **all three classes (source / locator / execution) are now
  live-captured**.
- `/exit` produced `SessionEnd:prompt_input_exit … status 0` and the binding
  detached (generation 2); Session A's window close produced
  `SessionEnd:other … status 0`, also detached. Both runs remain resumable.

## 8. Fail-visible semantics (absence evidence)

Zero `OBSERVATION_CAPTURE_FAILED` additionalContext occurrences in either
session — no capture failures occurred on host. By design, successful capture
is **silent** (exit 0, empty stdout); the host log shows only the benign
“Hook output does not start with {” line after each dispatch. The failure
path (fail-visible context naming the code, without claiming the tool failed)
is covered by the observation-hooks test suite.

## 9. Host-environment side observations (documented, not defects)

- **Node-version gate**: a launch under the machine-default Node 22.23.2 made
  the MCP child refuse to start — `UNSUPPORTED_NODE_VERSION: Phase Plan
  requires Node >= 24.15.0; running 22.23.2 … fail-closed` (debug2.log).
  Relaunching with Node 24 first on PATH connected cleanly. The gate works as
  designed on the real host.
- **MCP connect backoff**: the host caches an MCP connection failure for ~15
  minutes (`~/.claude/mcp-needs-auth-cache.json`), so an immediately following
  session skipped connecting entirely (debug3.log). Clearing that cache file
  and relaunching resolved it. Purely host behavior; the plugin cannot and
  should not work around it.

## 10. Prohibitions honored

No settings.json/settings.local.json modification, no defaultMode, no debug
MCP mutation tools, no capability-proofs editing; every permission was granted
through the real dialogs (number-key selection verified via debug.log, not
screenshots); no OAuth tokens, API keys, host-context secrets, or private
prompt transcripts are recorded here; host-context tokens visible in debug
logs are never reproduced.

## Result

| Gate (§79/§80) | Result |
| --- | --- |
| plugin load + live 5→6 migration (7-tool MCP) | PASS |
| /phase-plan entry → run (both sessions) | PASS |
| automatic capture: source / locator / execution | PASS (11 rows, 1:1 with dispatches, exact tool_use_id) |
| captured payload == result delivered to Claude | PASS (byte-identical file content; sha256 re-verified 11/11) |
| capture-time whole-file fingerprint (incl. partial reads) | PASS (equals pre-computed hash) |
| list_observations (live, signed context, summaries only) | PASS |
| promote_evidence — all four kinds, five revisions | PASS |
| validation strategy rule (fingerprint ×2, reobserve ×3) | PASS |
| audit: EVIDENCE_PROMOTED only, append-only history intact | PASS |
| no mutation (HEAD / run revision / epoch untouched) | PASS |
| multi-session fencing (selection_required → explicit user choice) | PASS |
| SessionEnd detach (both sessions) | PASS |
