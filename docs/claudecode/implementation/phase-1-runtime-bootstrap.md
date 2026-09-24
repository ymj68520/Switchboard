# Phase 1 Implementation Note — Runtime Bootstrap & Capability Preflight

Scope: how Phase Plan Phase 1 is actually implemented and operated. The
architecture authority remains
`docs/claudecode/spec/claude-code-phase-plan-v0.1-architecture-spec.md`
(frozen v0.1); nothing here amends it.

## Implementation root

```text
adapters/claude-code/
```

The repo convention is one workspace package per host under `adapters/`
(`adapters/opencode` exists already; `packages/*` are still empty skeletons),
so the Claude Code plugin root is the `@switchboard/claude-code` workspace
package. Its layout maps onto the frozen plugin structure (spec §27):

```text
adapters/claude-code/
├── .claude-plugin/plugin.json    minimal manifest (Phase 1 scaffold)
├── skills/phase-plan/SKILL.md    placeholder (full protocol ships later)
├── agents/validator.md           placeholder
├── hooks/hooks.json              empty hook map ({"hooks": {}})
├── .mcp.json                     stdio MCP entry, plugin-relative
├── dist/phase-plan-runtime.mjs   built artifact (gitignored, reproducible)
├── src/                          runtime sources (below)
└── test/                         vitest suite
```

Host-neutral reuse: the existing OpenCode adapter is OpenCode-specific and
`packages/*` are empty, so no premature shared layer was extracted (plan §19.4);
Phase 1 code is local to the Claude adapter.

## Runtime entry point and source layout

Single artifact, role subcommands (spec §28.1):

```text
node phase-plan-runtime.mjs doctor [--json]
node phase-plan-runtime.mjs mcp
node phase-plan-runtime.mjs hook <event>    reserved dispatch, Phase 1 stub
```

```text
src/
├── runtime.ts                    entry: argv → dispatch, central error boundary
├── runtime/
│   ├── dispatch.ts               typed RuntimeCommand model, usage, execution
│   ├── exit-codes.ts             exit code policy + error→exit mapping
│   ├── errors.ts                 RuntimeError envelope (stable codes)
│   ├── logger.ts                 stderr-only logger (PHASE_PLAN_LOG_LEVEL)
│   ├── node-version.ts           semver parse/compare, REQUIRED_NODE_VERSION
│   └── version.ts                runtime name/version constants
├── doctor/
│   ├── doctor.ts                 orchestration, injectable probes
│   ├── checks.ts                 check model + per-check builders
│   ├── report.ts                 report schema, human/JSON renderers, exit derivation
│   └── capabilities.ts           centralized Claude compatibility policy
├── claude/
│   ├── version.ts                `claude --version` detection/parsing
│   └── environment.ts            plugin env classification + data preflight
├── store/
│   └── sqlite-capability.ts      node:sqlite in-memory smoke test
└── mcp/
    └── bootstrap.ts              stdio MCP server bootstrap
```

## Node prerequisite

`REQUIRED_NODE_VERSION = "24.15.0"` (spec §26.1), full semver comparison —
never major-only. `doctor` reports the check from any Node version; `mcp`
fail-closes (`UNSUPPORTED_NODE_VERSION`, exit 3) on unsupported Node.

## Build

```bash
cd adapters/claude-code
npm run build    # esbuild → dist/phase-plan-runtime.mjs (ESM, node24 target)
```

The MCP SDK is bundled at build time; the machine running the plugin never
needs `npm install`. Node built-ins stay external. `dist/` is reproducible and
gitignored per repo convention.

## Doctor

```bash
node dist/phase-plan-runtime.mjs doctor          # human-readable
node dist/phase-plan-runtime.mjs doctor --json   # machine-readable
```

Two-tier semantics: **runtime readiness** (node, node:sqlite) and **Claude
host integration** (CLI, capabilities, plugin env, plugin data). Plugin
session variables missing outside Claude Code is `NOT_ACTIVE`
(informational), never "broken". Exit codes: 0 READY; 3 node/sqlite; 4
Claude CLI/capabilities; 5 plugin data; per `src/runtime/exit-codes.ts`.

JSON schema (`phase-plan.doctor-report/1`, key-order stable, no timestamps):
`schema`, `runtime{name,version}`, `overall`, `hostIntegration`,
`checks{node, sqlite, claudeCli, claudeCapabilities, pluginEnvironment,
pluginData}`; each check has `id/label/tier/status(PASS|FAIL|UNKNOWN|NOT_ACTIVE)/
required/errorCode?/message?/detail?`.

Checks:

- **node** — semver ≥ 24.15.0 with `detected`/`required` in the report.
- **node:sqlite** — real `:memory:` smoke: load module, open, CREATE/INSERT
  (in a transaction), SELECT, deterministic close. No schema is created
  (Phase 2 scope).
- **Claude CLI** — `spawn(shell:false)` of `claude --version`, candidates
  `claude` (covers `.exe`/POSIX) plus `claude.cmd` on Windows launched via
  `cmd.exe /d /s /c` with a fixed argv (Node refuses `.cmd` without a shell;
  no `which`/`where`, no user input in the command). `PHASE_PLAN_CLAUDE_BIN`
  overrides. Structured outcomes: `not_found` / `unreadable` / `ok`.
- **capabilities** — per-capability compatibility policy (below), UNKNOWN
  fail-closed for critical entries.
- **plugin env** — `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` (plugin_runtime),
  `CLAUDE_PROJECT_DIR`/`CLAUDE_CODE_SESSION_ID` (host_session).
- **plugin data** — when `CLAUDE_PLUGIN_DATA` is set: resolve, create root +
  `store/ blobs/ backups/ exports/` (spec §25.1 layout) if absent, write-probe
  with guaranteed cleanup; failures map to `PLUGIN_DATA_UNAVAILABLE` /
  `PLUGIN_DATA_NOT_WRITABLE`.

## Claude compatibility policy

Centralized in `src/doctor/capabilities.ts` as a **per-capability** policy
matrix (correction 2026-09-24: the single global minimum was replaced — the
Approval security boundary must not be inferred from a general version
gate). Each entry declares `verification`, optional `minimumVersion`,
`critical`, `reason` (architecture basis), and `evidence`:

| capability | verification | minimumVersion | critical | evidence/basis |
|---|---|---|---|---|
| plugins | version | 2.0.0 | yes | plugin system + marketplace GA with Claude Code v2.0.0 (official release notes, 2025-09) |
| stdioMcp | version | 2.0.0 | yes | plugin-scoped `.mcp.json` registration ships with the plugin system (GA v2.0.0) |
| planModeIntegration | unknown | — | no | no reliable official floor for session-scoped plan transitions; Plan Mode is the host-owned boundary (spec §6.1) and Phase Plan guards (§6.3) are the fail-closed backstop |
| requiredUserInteraction | version | **2.1.199** | yes | correction directive 2026-09-24; official changelog documents `requiresUserInteraction` handling (allow-rule bypass fix) by 2.1.246 |
| hookLifecycle | unknown | — | no | no reliable official floor for the exact event set; absence degrades observation/recovery UX, not the fail-closed write boundary |

Evaluation semantics:

- `verification: "version"` entries PASS/FAIL against their floor; unreadable
  or missing version ⇒ UNKNOWN.
- `verification: "unknown"` entries are NEVER PASS from a version number —
  they stay UNKNOWN until runtime probes exist (Phase 2 promotion path).
- `supported` is true only when every **critical** capability is a proven
  PASS. A critical UNKNOWN or FAIL closes the gate (architecture §13.4);
  UNKNOWN ≠ SUPPORTED.
- Floors live only in this module and are pinned by
  `test/capabilities.test.ts` — never in business code.

Doctor outcomes: Claude 2.1.198 ⇒ `requiredUserInteraction` FAIL ⇒
`CLAUDE_CAPABILITY_UNSUPPORTED`, host integration NOT_READY, exit 4. Claude
≥ 2.1.199 ⇒ approval gate PASS; `planModeIntegration`/`hookLifecycle` are
reported as UNKNOWN (visible in the JSON `detail` and the human message)
without blocking readiness.

## MCP bootstrap

`@modelcontextprotocol/sdk` low-level `Server` + `StdioServerTransport`.
Identity `phase-plan` v0.1.0; capabilities `{tools:{}}`; `tools/list` returns
`[]` — the Phase 2 tool-registration boundary, with no domain mutation tools
and no frozen-contract violations. All diagnostics go to stderr
(`[phase-plan] …`, `PHASE_PLAN_LOG_LEVEL=debug|info|warn|error|silent`);
stdout carries protocol messages only. Clean shutdown on stdin end/transport
close.

`.mcp.json` references the runtime plugin-relatively:

```json
{ "mcpServers": { "phase-plan": {
    "command": "node",
    "args": ["${CLAUDE_PLUGIN_ROOT}/dist/phase-plan-runtime.mjs", "mcp"] } } }
```

## Tests

```bash
cd adapters/claude-code
npm test          # pretest builds the bundle, then vitest run
npm run typecheck
npm run lint
```

74 tests: semver/Claude-version parsing, capability registry, arg parsing,
error→exit mapping, env classification, plugin-data preflight (real fs
including spaces/Unicode paths + injected failure paths), sqlite probe
(injected module + real `node:sqlite`), doctor integration (all probes
injected — no dependence on a specific installed Claude version), and an MCP
bundle smoke over real stdio (protocol purity on stdout, clean exit; on
unsupported Node it asserts the fail-closed refusal).

Verified on Node v24.21.0 (doctor READY exit 0, real Claude Code 2.1.276
detected via the `.cmd` shim, MCP handshake round-trip) and Node v22.23.2
(doctor NOT_READY exit 3, MCP refuses fail-closed).

## Known limitations (intentional, Phase 2+ scope)

- Capability checks are per-capability version policy; `planModeIntegration`
  and `hookLifecycle` have no verified official floor and report UNKNOWN
  (non-blocking) until runtime probes land in a later phase.
- `hook <event>` parses and classifies known events (SessionStart,
  UserPromptSubmit, PreToolUse, PostToolBatch, PostCompact, FileChanged) but
  every handler is an explicit `HOOK_NOT_IMPLEMENTED` stub.
- No SQLite schema, no PlanningRun/Store/Plan Memory, no HostContextEnvelope.
- SKILL.md / validator.md / hooks.json are minimal placeholders.
- `claude.cmd` shim detection on Windows goes through `cmd.exe` with a fixed
  argv (documented above); a native-installer `claude.exe` is found directly.
