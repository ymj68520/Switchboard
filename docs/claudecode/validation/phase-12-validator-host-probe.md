# Phase 12 §4 — Real validator host probe (Claude Code 2.1.283, Windows 10.0.19044)

Date: 2026-09-26. Scratch plugin `phase12-probe` (not part of Switchboard) at
`C:\Users\Administrator\phase12-probe\probe-plugin` with `agents/validator.md`,
a minimal MCP server (`probe` server, tools `probe_ping`/`probe_report`), and a
catch-all PreToolUse hook that records the COMPLETE raw hook input JSON.
Runs: headless `claude -p` in `C:\Users\Administrator\phase12-probe\ws`
(run 1 fresh, run 2 fresh, run 3 `--continue` resume). Log: `hook-log.jsonl`.

## A — plugin agent discovered

YES. `agents/validator.md` registers as `phase12-probe:validator`
(`<plugin-name>:<agent-name>`). Observed in the Agent tool call:

```json
{"tool_name":"Agent","tool_input":{"description":"…","prompt":"…","subagent_type":"phase12-probe:validator"}}
```

The Agent tool refused to spawn when the whitelist resolved to zero tools
(see D) — which also proves the agent definition was parsed.

## B — isolated context

YES. The spawn runs as a background task with its own context: a
`task-notification` with `task-id == agent_id` is delivered to the main
session when it finishes; the validator's tool calls never appear in the main
transcript; the validator's function-definition set is its own (only the
whitelisted tool).

## C — model tier

`model: opus` frontmatter accepted. This environment routes all tiers through
a proxy (`ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.3-flash-cc[1M]`,
`CLAUDE_CODE_SUBAGENT_MODEL` same), so "opus tier" is observable only as the
host honoring the `opus` alias — the validator spawn required a fully parsed
agent definition and ran with the configured opus-alias model. Background
subagent transcripts are not persisted in this setup, so the exact served
model string could not be dumped; recorded as an environment limitation, not
a host gap. On a native account the same frontmatter selects Opus.

## D — tools whitelist restricts to plugin MCP tools

YES, enforced at the tool-definition level and fail-closed:

- Whitelist `tools: mcp__plugin_phase12-probe_probe__probe_ping` → validator's
  function set contains exactly that tool; `probe_report` is absent ("the only
  tool exposed to me is …").
- Wrong name (`mcp__probe__probe_ping`, missing the plugin segment) → Agent
  tool REFUSES the spawn: "Agent 'phase12-probe:validator' would be spawned
  with zero tools — refusing. Its tools list resolved to nothing:
  unrecognized [mcp__probe__probe_ping]". No fallback to all tools.
- Real registered names carry a plugin segment:
  `mcp__plugin_<plugin-name>_<server-name>__<tool-name>`, and hook input adds
  `mcp_server: {"name":"plugin:<plugin>:<server>","source":"plugin"}`.
- With `ENABLE_TOOL_SEARCH=true`, a validator attempt to call the
  non-whitelisted name got fuzzy-resolved to the whitelisted tool by the
  tool-search layer (model-layer artifact; the host never exposes the denied
  tool). Server-side fences must not rely on tool hiding (§54 stands).

## E — hook input carries stable subagent host facts

YES. PreToolUse hook input for a SUBAGENT MCP tool call (complete payload):

```json
{
  "session_id": "1561f18a-…",
  "transcript_path": "…\\1561f18a-….jsonl",
  "cwd": "…\\ws",
  "prompt_id": "4b12f26d-…",
  "permission_mode": "bypassPermissions",
  "agent_id": "a50b56a7a080875a8",
  "agent_type": "phase12-probe:validator",
  "effort": {"level": "max"},
  "hook_event_name": "PreToolUse",
  "tool_name": "mcp__plugin_phase12-probe_probe__probe_ping",
  "tool_input": {},
  "tool_use_id": "call_dbd69c3daacc45da9bc2d450",
  "mcp_server": {"name": "plugin:phase12-probe:probe", "source": "plugin"}
}
```

`agent_id` (opaque, == the background task id) and `agent_type`
(`<plugin>:<agent-name>`) are the documented-at-runtime subagent identity
fields. Both are absent from main-session calls.

## F — hook distinguishes main vs validator on the SAME tool

YES. Same tool `mcp__plugin_phase12-probe_probe__probe_ping`, same session,
same transcript:

- main call → NO `agent_id`/`agent_type` fields
- validator call → `agent_id` + `agent_type` present

Across 3 runs: 100% consistent (7 validator calls all carried both fields;
all main calls carried neither).

## G — /clear / resume does not inherit validator authority

YES (tested with `claude -p --continue` on the same session). After resume:

- main's own calls still carry NO agent fields — main never inherits
  validator identity from the earlier subagent turn;
- a NEW validator spawn in the resumed session gets a NEW `agent_id`
  (`aab0ce342c1260742` vs earlier `a50b56a7a080875a8`) with the SAME
  `agent_type` — i.e. `agent_id` is per-spawn provenance and `agent_type` is
  the durable identity discriminator.

## Additional facts recorded

- Plugin content (agents included) is snapshotted at session startup; edits to
  `validator.md` mid-session do not apply to that session.
- Subagent `PreToolUse` input keeps `session_id`/`transcript_path` of the MAIN
  session (identity must come from the agent fields, not the transcript path).
- `prompt_id` changes per user prompt; `permission_mode` is present
  (`bypassPermissions` in the probe) and usable for the plan-mode requirement.

## Design decision for Phase 12 (feeds §5–§7)

Signable caller attestation EXISTS: the plugin's own PreToolUse hook reads
`agent_type` from host input and folds `{agentId, agentType}` into the signed
HostContext envelope (V2). The model cannot forge the envelope signature
(host-secret HMAC), cannot inject hook input, and the server requires
`agentType === "phase-plan:validator"` for `submit_validation` and the
ABSENCE of a validator agentType for main-only capabilities. No
ARCHITECTURE_BLOCKER is needed.
