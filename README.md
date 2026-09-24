# Switchboard

**The intelligent model router for AI coding agents.**

Route every task to the right model at the right time.

Switchboard is a cross-platform model and inference router for AI coding agents.

It automatically selects the appropriate model based on the current workflow stage, allowing coding agents to use stronger reasoning models for planning and complex tasks while using faster, more efficient models for execution and routine work.

## Supported Agents

Switchboard is designed to support:

* Claude Code
* Codex
* OpenCode

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

```text
                     Switchboard
                         │
                  Routing Engine
                         │
          ┌──────────────┼──────────────┐
          │              │              │
          ▼              ▼              ▼
    Claude Code        Codex         OpenCode
       Adapter         Adapter        Adapter
          │              │              │
          ▼              ▼              ▼
        Model          Model          Model
```

The project is organized as a monorepo:

```text
packages/
  core/       Shared routing engine
  config/     Configuration and policy system
  cli/        Switchboard CLI

adapters/
  claude-code/
  codex/
  opencode/
```

The shared core must remain independent from any specific coding agent or model provider.

Each adapter is responsible for translating native host state into Switchboard routing decisions and applying those decisions using capabilities supported by that host.

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
switchboard-ai/
├── README.md
├── docs/
├── packages/
│   ├── core/
│   ├── config/
│   └── cli/
├── adapters/
│   ├── claude-code/
│   │   ├── hooks/
│   │   └── skills/
│   ├── codex/
│   │   ├── hooks/
│   │   └── skills/
│   └── opencode/
├── presets/
├── examples/
│   ├── claude-code/
│   ├── codex/
│   └── opencode/
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
└── scripts/
```

## Status

Switchboard is currently in the initial architecture and research stage.

The first milestone is to establish reliable model routing for Plan and Execute workflows across Claude Code, Codex, and OpenCode without relying on speculative or unsupported host APIs.

## Roadmap

**Phase 1 — Foundation**

Define the repository architecture, routing model, configuration format, and host adapter contracts.

**Phase 2 — OpenCode**

Implement the first working adapter using OpenCode's native agent and model configuration capabilities.

**Phase 3 — Claude Code**

Integrate with Claude Code's native plugin, hook, and model-routing capabilities.

**Phase 4 — Codex**

Implement Codex routing using supported plugin and lifecycle mechanisms, with explicit fallback behavior where runtime model switching is unavailable.

**Phase 5 — Unified Routing**

Provide a consistent Plan / Execute routing experience across all supported coding agents.

## License

License to be determined.
