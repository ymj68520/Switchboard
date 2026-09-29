# Switchboard

**The intelligent model router for AI coding agents.**

Route every task to the right model at the right time.

Switchboard is a cross-platform model and inference routing project for AI coding agents.

Its goal: let coding agents use stronger reasoning models for planning and complex tasks while using faster, more efficient models for execution and routine work — selected from the current workflow stage, not by manual model switching.

## Supported Agents

Switchboard currently ships one adapter per host:

* Claude Code — **Phase Plan**, a persistent, approval-driven planning plugin
* Codex — **phase-model**, a phase-triggered Plan/Default model switcher
* OpenCode — **Ultra Plan**, a deterministic planning harness with Build handoff

Additional coding agents may be supported in the future.

## The Idea

Different stages of a coding workflow have different inference requirements.

```text
PLAN
  → frontier model
  → maximum reasoning

EXECUTE
  → balanced model
  → normal reasoning

REVIEW
  → frontier model
  → high reasoning

EXPLORE
  → fast model
  → low reasoning
```

Instead of manually switching models, Switchboard aims to detect the current workflow state from the coding agent and apply the appropriate routing policy automatically.

## Architecture

Switchboard separates shared routing policy from host-specific integrations.

Each adapter is responsible for translating native host state into Switchboard routing decisions and applying those decisions using capabilities supported by that host.

```text
    Claude Code           Codex            OpenCode
       Adapter           Adapter           Adapter
     "Phase Plan"      "phase-model"      "Ultra Plan"
```

The three adapters shipped today are self-contained; the shared routing core
that will sit underneath them is planned but not implemented yet:

```text
packages/
  core/       Shared routing engine (planned)
  config/     Configuration and policy system (planned)
  cli/        Switchboard CLI (planned)

adapters/
  claude-code/   Phase Plan — persistent, approval-driven planning plugin
  codex/         phase-model — Plan/Default model switcher for Codex CLI
  opencode/      Ultra Plan — deterministic planning harness with Build handoff
```

The shared core must remain independent from any specific coding agent or model provider.

Adapter user guides:

* Claude Code: [`adapters/claude-code/README.md`](adapters/claude-code/README.md)
* Codex: [`adapters/codex/README.md`](adapters/codex/README.md)
* OpenCode: [`adapters/opencode/README.md`](adapters/opencode/README.md) — Ultra Plan, the `/ultra-plan` planning harness

## Routing

Switchboard is designed around normalized workflow stages such as:

```text
plan
execute
review
explore
debug
test
```

Policies map workflow stages to model capability tiers:

```text
frontier
balanced
fast
```

For example:

```text
plan       → frontier
execute    → balanced
review     → frontier
explore    → fast
```

Individual adapters then map those tiers to models available in their host environment.

This allows routing policies to remain stable even as model names and providers change.

Today this policy is implemented only in the Codex adapter (phase-model), which switches between a configured planning model and execution model on real Plan/Default mode transitions. The two planning adapters (Phase Plan, Ultra Plan) do not perform dynamic model routing — they run on the host session's configured model.

## Design Principles

### Host-native first

Use native model, agent, plugin, and lifecycle capabilities whenever possible.

### Deterministic state first

Prefer real host state such as Plan Mode or active agent state over LLM-based prompt classification.

### Policy over model names

The routing engine should operate on capabilities and tiers rather than hard-coded provider model IDs.

### Explicit capability differences

Claude Code, Codex, and OpenCode do not necessarily expose identical model-switching capabilities.

Switchboard should represent those differences explicitly instead of pretending every host behaves the same way.

### Graceful fallback

Unsupported routing operations should fall back safely and predictably.

### Observable routing

Users should be able to understand why Switchboard selected a particular model or inference policy.

## Project Structure

```text
switchboard/
├── README.md
├── docs/                  frozen specs, phase reports, and validation records
├── packages/              reserved for the shared routing core (empty today)
│   ├── core/
│   ├── config/
│   └── cli/
├── adapters/
│   ├── claude-code/       Phase Plan plugin (skills, hooks, agents, MCP runtime)
│   ├── codex/             phase-model launcher (bin, src, docs)
│   └── opencode/          Ultra Plan plugin (src, scripts)
├── examples/              reserved (empty today)
├── presets/               reserved (empty today)
├── tests/                 release and marketplace fixtures
├── scripts/               release packaging and live smoke tests
└── .github/workflows/     CI
```

## Status

Switchboard's first release, **v0.1** (2026-09-29), ships all three adapters as a single GitHub Release:

| Host | Product | Version | Scope |
| --- | --- | --- | --- |
| Claude Code | Phase Plan | 0.1.1 | persistent, approval-driven planning with execution handoff |
| Codex CLI | phase-model | 0.0.1 | automatic Plan/Default model switching for the Codex TUI |
| OpenCode | Ultra Plan | 0.1.0 | deterministic planning harness (`/ultra-plan`) with same-session Build handoff |

Distribution is GitHub Release assets only; nothing is published to npm. See each adapter's README for validated environments, installation steps, and known limitations.

## Roadmap

**Phase 1 — Foundation — done**

Repository architecture, per-adapter specifications, and host adapter contracts are frozen and recorded under `docs/`.

**Phase 2 — OpenCode — shipped**

Ultra Plan v0.1.0: a deterministic planning harness built on OpenCode's native agent and command capabilities.

**Phase 3 — Claude Code — shipped**

Phase Plan v0.1.1: approval-driven persistent planning on Claude Code's native plugin, hook, and MCP capabilities.

**Phase 4 — Codex — shipped**

phase-model v0.0.1: Plan/Default model switching over Codex's app-server protocol, with fail-open fallback when switching is unavailable.

**Phase 5 — Unified Routing — open**

Provide a consistent Plan / Execute routing experience across all supported coding agents via the shared routing core (`packages/`).

## License

Switchboard is released under the MIT License. See [`LICENSE`](LICENSE).

Each released adapter — Ultra Plan for OpenCode (`adapters/opencode`),
Phase Plan for Claude Code (`adapters/claude-code`) and the Codex CLI
Phase Model Switcher (`adapters/codex`) — carries the same MIT license
in its own directory.
