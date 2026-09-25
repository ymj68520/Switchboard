# Phase 7 Implementation Note — Claude Host Authority, Lifecycle Guard & Formal Approval Bridge

Phase: 7 · Adapter: `@switchboard/claude-code` · Baseline: `713d831 → … → 2aeabd0`
Disposition: **PARTIAL** — `ARCHITECTURE_BLOCKER_PLAN_MODE_RESUME` (§70), everything else implemented and green.

---

## 1. Real Claude capability probe (§1) — method and result

**Method.** The installed host is Claude Code **2.1.276** (`claude --version`). Two probe channels were planned: (a) official documentation evidence, (b) behavioral probes against the installed host via a temporary probe plugin (`--plugin-dir`, headless `claude -p` with dumping hooks and a hand-rolled stdio MCP server). Channel (b) is **blocked in this environment**: the host is installed but not authenticated (`claude auth status` → `loggedIn: false, authMethod: "none"`; no `ANTHROPIC_API_KEY` in the environment; `claude -p` exits with "Not logged in"). No authentication was attempted on the user's behalf. All A–G answers therefore rest on official documentation, version-pinned to the installed 2.1.276.

| Probe | Result | Evidence (official docs, verified against 2.1.276) |
|---|---|---|
| A. PreToolUse `updatedInput` on plugin MCP tools | **YES (documented)** | Hooks reference: PreToolUse supports `updatedInput` under `hookSpecificOutput`, replacing tool arguments before execution |
| B. PreToolUse `permissionDecision:"ask"` → PermissionRequest | **YES (documented)** | `ask` forces the permission prompt; PermissionRequest fires "when Claude Code is about to ask you for permission" |
| C. PermissionRequest `updatedPermissions: setMode(plan, session)` | **YES (documented)** | PermissionRequest accepts a `decision` object with `behavior` + `updatedPermissions`; permission-update entries carry a `type` and a `destination` (session scope is a documented destination) |
| D. Next observable hook reports `permission_mode=plan` | **YES (documented)** | `permission_mode` is a common hook input field; values include `default`, `plan`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions` |
| E. `/phase-plan` skill turn uses Opus | **YES (documented)** | Skill frontmatter `model: opus` pins the turn's model; implemented in SKILL.md |
| F. Plan-Mode inference follows opusplan planning tier | **YES (documented)** | `model: opus` at entry plus session mode `plan`; the opusplan tier routes plan-mode turns to Opus |
| G. `/resume` auto-restores Plan Mode | **NO (documented)** | See §2 below |

Behavioral confirmation of A–D (and of plugin MCP tool naming) remains an open runtime-probe task; the capability-proof file records this honestly — both `hookLifecycleVerified` and `planModeIntegrationVerified` stay **false** on this machine until a real probe succeeds.

**Version facts established** (all satisfied by 2.1.276): `anthropic/requiresUserInteraction` enforced since **2.1.199** (matches `REQUIRED_USER_INTERACTION_VERSION`); non-interactive plan-mode restore since **2.1.246**; hyphenated hook matchers since **2.1.195**; `prompt_id` on hook input since **2.1.196**.

## 2. Plan Mode resume blocker (§2/§70)

Factual answer to the mandatory recovery gate — *"Can an exact-session `/resume` restore Phase Plan's required Plan Mode automatically using current documented Claude Code plugin mechanisms?"* — is **NO**:

- Sessions doc: on interactive terminal resume (`claude --resume <id>` / `--continue`), plan is explicitly listed as the exception that is **not** restored (the session starts in "the permission mode a new session would start in").
- `/resume` inside a live session keeps the *current* session's mode; the launch session picker starts in the new-session mode.
- The only documented plan-restore paths are non-interactive `claude -p --resume` **with** `--permission-prompt-tool` (v2.1.246+) and the VS Code path — neither is the interactive `/resume` UX Phase Plan requires.
- There is **no** documented SessionStart → permission-mode mechanism: SessionStart output supports `additionalContext`, `sessionTitle`, `reloadSkills`, env-file injection — not permission changes.

Per directive §2, no workaround was attempted (no settings edits, no `defaultMode=plan`, no nested Claude, no simulated input, no undocumented IPC). Frozen semantics were not amended; an Architecture Amendment would be required to change "exact-session /resume restores Plan Mode" into "user re-invokes /phase-plan". **Disposition: PARTIAL.**

## 3. HostContextEnvelopeV1 (§17/§18)

`src/host/host-context.ts` — version 1 envelope: `sessionId, promptId?, workspaceId, runId?, bindingGeneration?, permissionMode, toolUseId, toolName, businessInputHash` + HMAC `signature`, serialized as a base64url JSON token. Field authority follows §18 exactly: hook current input for session/prompt/mode/toolUseId/toolName; authoritative workspace discovery/catalog for `workspaceId`; SessionBinding Store for `runId`/`bindingGeneration` — the latter two are **signed observations only**; every mutation still revalidates against the Store (§23, proven by the E57 test). The MCP process environment is never read for authority (§19); there is no reference to `CLAUDE_CODE_SESSION_ID` anywhere in production code.

`businessInputHash` = SHA-256 over `canonicalJson(business input minus reserved fields)`, reserved fields being `_hostContext` and `_entryIntent` (§20). The handler recomputes the hash; mismatch → `HOST_CONTEXT_INPUT_MISMATCH` **before** any Phase 6 logic (E59 proves it fires before `PROPOSAL_HASH_MISMATCH`). Tool binding uses `logicalToolName` (the segment after the last `__`), because plugin-bundled MCP servers expose tools as `mcp__plugin_<plugin>_<server>__<tool>`; cross-tool replay fails `HOST_CONTEXT_TOOL_MISMATCH` (E58).

**Deviation recorded:** the directive's literal matcher `mcp__phase-plan__start_or_resume` does not exist on the real host — plugin servers get the scoped name above. hooks.json therefore uses the regex `phase.plan__(start_or_resume|approve_proposal)` for PermissionRequest and an unscoped PreToolUse (needed anyway for §42's unknown-tool default-deny).

## 4. Secret storage (§6) and signatures (§7)

`src/host/secret.ts`: `${CLAUDE_PLUGIN_DATA}/runtime/host-context.key`, 32 random bytes (`crypto.randomBytes`, 256-bit) hex-encoded; created atomically via `open(..., "wx")` so the losing racer of a Hook/MCP create race re-reads the winner's key; deterministic read; persistent across upgrades; **corruption fails closed** (`HOST_SECRET_UNAVAILABLE`, tested for non-hex and sub-256-bit content); POSIX `0600` best-effort, no Windows ACL pretense; `node:crypto` only.

`src/host/signing.ts`: per-domain keys — `domainKey = HMAC-SHA256(secret, domain)` — and signatures `HMAC-SHA256(domainKey, canonicalJson(payload))`, with the existing canonical-JSON seam. Domains: `phase-plan:entry-intent:v1`, `phase-plan:host-context:v1`. Cross-domain verification is impossible by construction (tested). Constant-time comparison.

## 5. EntryIntentV1, UserPromptExpansion, /phase-plan skill (§8–§11, §62/§63)

`src/host/entry-intent.ts`: token binds `version=1, sessionId, promptId, commandName:"phase-plan"` + signature; opaque base64url; never persisted to the Plan Store (asserted by test). The `UserPromptExpansion` hook (matcher `phase-plan`) issues the token into the skill turn via `additionalContext` with the stable marker `phase-plan:entry-v1 token:`. Missing `prompt_id` fails closed. SKILL.md (`skills/phase-plan/SKILL.md`) carries `name: phase-plan`, `disable-model-invocation: true`, `model: opus`, no `context: fork`, and instructs the model to pass the token verbatim as `_entryIntent`, never to fabricate one, and to surface `selection_required` to the user. Core invariants are not duplicated into the skill (§9).

Replay: a token from prompt A fails at PreToolUse and at the MCP handler when compared against the current session/prompt (`ENTRY_INTENT_INVALID`, §63 tested); a model calling `start_or_resume` with no token gets `ENTRY_INTENT_REQUIRED` (§62 tested).

## 6. Hook layer (§33–§44)

Typed parsers (`src/hooks/parse.ts`): `parseHookCommonInput`, `parseSessionStartInput`, `parseUserPromptSubmitInput`, `parseUserPromptExpansionInput`, `parsePreToolUseInput`, `parsePermissionRequestInput`, `parseSessionEndInput` — unknown future fields tolerated, missing correctness-critical fields raise `HookInputError`, `hook_event_name` cross-checked against the argv event (§33/E39).

`src/hooks/run.ts` enforces stdout discipline (§34/E40): at most one JSON object on stdout, diagnostics on stderr, with the per-event failure policy documented in the module header (PreToolUse/Expansion → exit 2; UserPromptSubmit → block decision; PermissionRequest → deny decision; SessionStart/End → silent advisory success).

Handlers (`src/hooks/handlers.ts`):

- **PreToolUse `start_or_resume`**: verify EntryIntent (signature + current session/prompt) → discover/register the exact workspace → build+sign HostContext (with runId/generation when the session owns an active run in that workspace) → rewrite `tool_input` to `{business args, _entryIntent, _hostContext}` → `permissionDecision:"ask"` whose sole purpose is triggering PermissionRequest (§14, not a design approval).
- **PreToolUse `approve_proposal`**: verify owned active run (`STALE_SESSION_BINDING`), `permission_mode == plan` (`PLAN_MODE_REQUIRED`), cwd still inside the bound workspace (§44, `WORKSPACE_MISMATCH`) → sign context → rewrite input → **`ask`, never `allow`** (§29) so the host's mandatory human prompt still happens on top of `requiresUserInteraction`.
- **PreToolUse `get_state`**: read context, no permission decision.
- **PreToolUse `ExitPlanMode`**: denied whenever the session owns an active run, in any mode (§41/E20).
- **PreToolUse drift guard** (§42): active run + `permission_mode != plan` → allow only `Read, Glob, Grep, WebSearch, WebFetch, AskUserQuestion` (+ phase-plan tools); everything else — Write/Edit/NotebookEdit/Bash/PowerShell/Agent/ExitPlanMode/unknown external MCP tools — denied with `PLAN_MODE_REQUIRED`. Normal plan mode stays Claude Code's business (§43). No workspace discovery on this fast path.
- **UserPromptSubmit drift guard** (§39/§40/E19): binding+run reads only (no discovery); active run + not plan → `decision:"block"` with the exact frozen reason; the `/phase-plan` entry passes (raw `/phase-plan` prefix or the expanded prompt carrying the entry marker — both hook orderings covered); unknown mode fails closed for known active bindings.
- **PermissionRequest** (§15/§16/§30): for `start_or_resume` it re-verifies EntryIntent + HostContext + session/prompt relationship against its own input and only then returns `behavior:"allow"` + `updatedPermissions:[{type:"setMode",mode:"plan",destination:"session"}]` — session destination only, never settings files. Missing context (PreToolUse updatedInput did not reach this event) → no decision, ordinary flow; present-but-tampered → deny through the decision object. For `approve_proposal` it **never** returns an allow, never adds a rule, never "don't ask again" (E30).
- **SessionStart** (§36/§37): `startup` never attaches other sessions' runs; `resume` exact-session reattaches a detached active run when the workspace still matches (spec §23.4), generation+1; `clear`/`fork` (new session ids) inherit nothing; `compact` changes nothing; an attached run injects only the minimal marker (`run=`, `stage=`, `head=`) — no memory summarization, no context capsule.
- **SessionEnd** (§38/E23): best-effort detach (generation++), errors swallowed, run never aborted; correctness never depends on it firing.

Layered fail-closed model: a disabled or timed-out hook can never *create* authority — it can only remove the ability to mutate, because every mutating MCP handler independently verifies the signed context and fails closed with `HOST_CONTEXT_REQUIRED` (E55, §55).

## 7. MCP tools (§12/§13, §24–§28, §48–§52)

`src/mcp/tools.ts` + rewired `src/mcp/bootstrap.ts`. `tools/list` now exposes exactly `start_or_resume`, `get_state`, `approve_proposal` (§48/E38); `approve_proposal` carries `_meta: {"anthropic/requiresUserInteraction": true}` as a **real JSON boolean** (§28/E27), and its schema accepts only `proposal_id`, `proposal_revision`, `proposal_hash` plus reserved `_hostContext` — any model-supplied `authorizationRequestId/sessionId/workspaceId/runId/generation/approved/actor/force` field is rejected with `MCP_INPUT_INVALID`, never stripped (§27/§29/E29). `start_or_resume` does not use `requiresUserInteraction` (§13).

- **start_or_resume** (§24): Case A exact attached session → `resumed`; Case B detached own run → `reattachActiveRun`, generation+1, `resumed`+`reattached`; Case C no relevant runs → create new run + binding generation 1 (goal required, `INVALID_RUN_GOAL`); Case D other sessions' active runs + `auto` → structured `selection_required` (`RUN_SELECTION_REQUIRED`) with safe metadata (run id/stage/revision/lifecycle/created_at — no session ids) and `takeover_required: true`; Case E `action=start_new` → new run allowed while the session owns nothing attached. No `action=takeover` exists (§25); `TAKEOVER_REQUIRED` is defined and surfaced as the structured future path.
- **get_state** (§26/§50): read-only, session+workspace scoped; returns `run`, `binding`, `head {snapshotId, commitId}`, `awaitingProposal {id, revision, hash, type, title}`; never raw rows, secrets, or other sessions' ids (E36).
- **approve_proposal** (§31/§32): verification chain (signature → tool → input hash → workspace → plan mode → binding observation) then derives `authorizationRequestId = "mcp-approve:" + envelope.toolUseId` **from the signed HostContext, not tool input** (E32) and calls `commitAuthorizedProposal(...)` — the Phase 6 seam's **first and only production caller**. Success maps to §52's `{approved, approval_id, commit_id, snapshot_id, idempotent, new_run_revision, new_stage}`; failures map to stable error codes, never stack traces.

All Phase 6 revalidation survives: stale binding (E57: correctly-signed old generation still fails after takeover), stale run revision, HEAD binding, exact hash, idempotent replay of the same authorized invocation (E35), `PROPOSAL_ALREADY_COMMITTED` for a different proposal under the same request id.

## 8. Capability proofs and doctor (§45–§47)

`src/host/capability-proofs.ts`: `${CLAUDE_PLUGIN_DATA}/runtime/capability-proofs.json` — `claudeVersion, proofVersion, hookLifecycleVerified, planModeIntegrationVerified, verifiedAt`; corrupt/missing reads as absent (advisory). A proof recorded for a different Claude version is ignored (§46, tested). Doctor merges a **current-version** proof into `planModeIntegration`/`hookLifecycle` and reports `PASS (runtime verified on …)` — it never invents version floors and never runs an interactive probe (E43/E44). The `record-capability-proof` runtime command records operator-verified facts from the documented E2E procedure; it verifies nothing itself. On this machine both capabilities remain UNKNOWN (no authenticated host available).

## 9. Schema, boundary, and validation

- Schema stays **v5**; host authority metadata lives in runtime files, never canonical Plan Memory (§5/§65/E45 — tested end-to-end: entry + approve leave `PRAGMA user_version == 5`).
- `makeTestUserAuthorization` remains test-only; the production caller of `commitAuthorizedProposal` is now the `approve_proposal` handler (import-boundary tests extended and green).
- Validation results: Node 24.21.0 — typecheck ✓, lint ✓, build ✓, **405/405** tests (41 files); Node 22.23.2 dev regression — **405/405**; OpenCode worktree — typecheck ✓, build ✓, **373/373**, with unrelated concurrent WIP modifications present and untouched (no failure to isolate this cycle).
- Not executed: interactive real-host E2E (§53/§54/E41/E42) — blocked by host authentication in this environment; the repeatable probe/record procedure is documented above for a machine with a logged-in Claude Code.

## 10. Headline

Phase 7 wires `HostContext → SessionBinding authority → MCP tool → Phase 6 engine` and builds the complete Formal Approval bridge, but no runtime path on this machine has yet *demonstrated* Claude Code obtaining real user authorization or transitioning a real session into Plan Mode: the bridge is implemented, tested at every layer except the live host, and disposition is **PARTIAL** pending (a) `ARCHITECTURE_BLOCKER_PLAN_MODE_RESUME` and (b) the authenticated-host E2E probe.
