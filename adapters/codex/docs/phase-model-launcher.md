# phase-model — managed Codex session launcher (Codex adapter, Phase 5)

`phase-model` starts a **managed Codex CLI session**: your normal interactive
Codex TUI, plus automatic model switching between Codex's native **Plan** and
**Default** collaboration modes.

```text
phase-model [phase-model flags] [codex args...]
     │
     ├─ dedicated app-server (session-private, loopback only)
     ├─ internal controller + phase-model switcher
     └─ real Codex TUI attached to that app-server
```

## What it does

- **Default mode → `execution_model`** — applied at startup and on every
  Plan → Default transition.
- **Plan mode → `planning_model`** — applied on every Default → Plan
  transition.
- **`reasoning_effort`** — one startup default for both native keys
  (`model_reasoning_effort` and `plan_mode_reasoning_effort`).

Out of scope by design (no enforcement): same-mode `/model` picks, manual
reasoning-effort changes, per-turn model checks. Codex stays authoritative;
the launcher only reacts to real mode transitions, and only writes the
`model` field of the current thread.

## Configuration

Exactly three settings. There are **no default model slugs** — you must
configure both models.

| Setting            | Config file (JSON)   | Environment variable               | CLI flag             |
| ------------------ | -------------------- | ---------------------------------- | -------------------- |
| `planning_model`   | `planning_model`     | `CODEX_PHASE_MODEL_PLANNING_MODEL` | `--planning-model`   |
| `execution_model`  | `execution_model`    | `CODEX_PHASE_MODEL_EXECUTION_MODEL`| `--execution-model`  |
| `reasoning_effort` | `reasoning_effort`   | `CODEX_PHASE_MODEL_REASONING_EFFORT` | `--reasoning-effort` |

Precedence (lowest → highest): **defaults < config file < environment < CLI
flags**. The only built-in default is `reasoning_effort = "xhigh"`; both
model fields are required.

### Config file

`phase-model` reads `.codex-phase-model.json` from the working directory, or
the file given by `--config <path>` (an explicitly requested file must
exist). Both snake_case and camelCase keys are accepted:

```json
{
  "planning_model": "gpt-6-sol",
  "execution_model": "gpt-6-astra",
  "reasoning_effort": "xhigh"
}
```

Your native `~/.codex/config.toml` is **never read or written** by the
launcher — model/effort/endpoint are passed to the managed session as
process-local CLI overrides only.

### Launching

```bash
phase-model                                  # uses config file / env
phase-model --planning-model gpt-6-sol --execution-model gpt-6-astra
phase-model --reasoning-effort high          # both native effort keys = high
phase-model --no-alt-screen                  # unknown args pass through to codex
```

Reserved startup arguments (`--remote`, `--model`/`-m`, and `-c
model=…` / `-c model_reasoning_effort=…` / `-c plan_mode_reasoning_effort=…`)
are **rejected** with a clear conflict error — the managed launcher owns them
for the session it starts. Runtime `/model` inside the TUI is unaffected.

## Exit behavior

- Normal TUI exit → the launcher exits with the TUI's exit code.
- Bootstrap failure (app-server/Controller) or app-server crash → error on
  stderr, exit code 1. The app-server is never restarted.
- Controller/switcher runtime failure → **fail-open**: one warning, then the
  session continues as plain Codex.
- `Ctrl-C` → best-effort orderly cleanup; no orphan processes.

## Requirements

- Codex CLI on `PATH` (verified against 0.156.1; no hard version gate).
- Logged-in Codex (`codex login status`).
