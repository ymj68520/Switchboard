# Phase 17 — Host Compatibility Findings

Directive §44–§47, record per §51. Facts only; the validation-harness
configuration is explicitly NOT product configuration.

## Environment

- Claude Code **2.1.283**, Windows (win32 10.0.19044), Node 24.21.0,
  inline plugin via `--plugin-dir D:\...\adapters\claude-code`.
- Validation harness: session-scoped `--settings` overlay carrying the plugin's
  hooks (with `${CLAUDE_PLUGIN_ROOT}` substituted to absolute paths — user-scope
  hooks never receive the host-injected plugin env), `CLAUDE_CODE_EFFORT_LEVEL`
  and a 14-tool allow list so the mandatory dialogs surface. This overlay is the
  validation harness only; the plugin's committed `hooks.json` is unchanged and
  no persistent Claude settings were written (user settings sha256
  `def5d0df9e653e122abe9a868976d31d910a32d7b3ef2e927644a2170c4d7b4c`
  byte-identical before and after the whole phase; the golden workspace has no
  project/local settings files).

## §44/§45 — Tool Search probe

Configuration probed: Tool Search at the host DEFAULT (the `ENABLE_TOOL_SEARCH`
env override deliberately REMOVED from the session settings), fresh workspace,
fresh session.

Observed: `/phase-plan` entry, the start_or_resume PreToolUse signing and the
run creation all worked with tool search enabled-at-default; PreToolUse hooks
fired (10 invocations in the probe session) and the run reached discovery.

Conclusion: on this host version and default profile, Tool Search did not defer
or bypass correctness-relevant PreToolUse signing. No
`HOST_COMPATIBILITY_BLOCKER_TOOL_SEARCH_BYPASSES_HOST_CONTEXT` is recorded from
this probe. The validated launch profile remains `ENABLE_TOOL_SEARCH=false`
(belt-and-braces; Phase 15 observed deferred-MCP failures when tool search was
force-enabled via settings), and the §44 requirement to keep the setting
explicit in the launch contract moves to Phase 18 packaging.

## §46 — plugin hook discovery probe

Inline `--plugin-dir` mode (the validation mode): hooks, MCP server, skills and
`CLAUDE_PLUGIN_DATA` all resolve from the plugin directory; standalone with the
session settings overlay. A *cold normal installation* (marketplace install)
was not exercised: it requires the Phase 18 packaging/installer work, and the
inline mode's only harness needs (env pinning + allow list) are session-scoped.

Recorded for Phase 18: verify that a normally installed plugin receives
host-injected `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` for its hooks and MCP
server without any settings copy. Not a Phase 17 blocker under the validated
launch profile.

## Additional host facts (all live-observed, 2.1.283)

1. **Plugin MCP tool-schema snapshot is keyed on server identity+version.** A
   rebuilt server bundle with an unchanged version keeps serving the STALE tool
   schema to every session — including brand-new ones; unknown arguments are
   silently stripped from tool calls before PreToolUse. `/mcp → Reconnect`
   restores the connection but does NOT refresh the snapshot. Fix: ship a new
   `RUNTIME_VERSION` whenever the tool surface changes (`86ab73f`).
2. **MCP child kill does not auto-heal**: killing the MCP child leaves the
   session's tool surface dead until the operator reconnects via `/mcp`
   (§32 record); the session itself survives and the Store stays authoritative.
3. **PostToolUse does not fire for MCP error results**: a failed MCP tool call
   produces no PostToolUse event (Phase 14 fact, re-confirmed on the abort
   fail-closed path).
4. **PermissionRequest allow + requiresUserInteraction**: the mandatory dialog
   always surfaces (Phase 16 §38 A) and `updatedPermissions` is still dropped
   on that path (probe B unchanged — A2 semantics apply).
5. **Model-gateway escaping defect**: the relayed model appends a stray literal
   trailing backslash to long identifier values copied into JSON arguments;
   mitigated adapter-side (`90d510b`, identity-field trim with the exact-hash
   checks still failing closed).
6. **First-run trust dialog**: a fresh workspace's first session opens the
   folder-trust dialog with default "No, exit"; scripted sessions must seed
   trust or answer the dialog before any prompt.

## Release blockers deferred to Phase 18 (§47)

Under the validated launch profile (inline plugin, tool search off, session
settings overlay) ALL correctness gates pass. The following packaging items are
recorded for Phase 18 and are not correctness blockers:

- launch/install contract: pinned `ENABLE_TOOL_SEARCH=false` (or verified
  tool-search-safe versions), plugin installation hook/MCP discovery without
  the settings overlay (§46), Windows launcher environment;
- tool-schema refresh contract: hosts must re-list plugin tools on
  reconnect/restart, or plugins must bump versions (product now does).

No correctness blocker (authority, durability, fencing, idempotency, recovery,
main E2E) was deferred.
