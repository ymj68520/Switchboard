# phase-model — managed Codex CLI session with automatic Plan/Default model switching

`phase-model` (package `@switchboard/codex`) starts your normal interactive
[OpenAI Codex CLI](https://github.com/openai/codex) TUI and adds one
capability: **phase-triggered model switching**.

```text
phase-model
 ├─ session-dedicated app-server  (loopback only, OS-assigned port)
 ├─ internal controller + switcher (observes Plan/Default, writes the model)
 └─ the real Codex TUI attached to that app-server
```

- Codex **Default** mode → `executionModel`
- Codex **Plan** mode → `planningModel`

It is **not** a proxy, plugin, hook, or daemon, and it never enforces a
model per turn. Codex stays fully authoritative; the launcher only reacts
to real collaboration-mode transitions.

## Requirements

- **Node.js ≥ 22.4.0** (uses Node's built-in WebSocket client).
- **OpenAI Codex CLI already installed and resolvable on `PATH`**, and
  logged in (`codex login status`). phase-model does **not** install,
  download, or upgrade Codex.
- Validated with codex-cli **0.156.1**. Compatibility is verified at
  runtime (app-server `/readyz`, protocol handshake, real thread
  capability) — there is no hardcoded version gate.

## Configuration

Exactly three settings; both models must come from configuration — there
are no built-in model slugs.

| Setting         | Meaning                                   | Default |
| --------------- | ----------------------------------------- | ------- |
| `planningModel` | model applied while Codex is in Plan mode | —       |
| `executionModel`| model applied in Default mode and at startup | —    |
| `reasoningEffort`| startup reasoning effort for both native Codex defaults | `xhigh` |

Sources, lowest → highest precedence:

1. defaults (only `reasoningEffort` has one),
2. config file **`.codex-phase-model.json`** in the working directory
   (or the file given by `--config <path>`),
3. environment variables `CODEX_PHASE_MODEL_PLANNING_MODEL`,
   `CODEX_PHASE_MODEL_EXECUTION_MODEL`, `CODEX_PHASE_MODEL_REASONING_EFFORT`,
4. CLI flags `--planning-model`, `--execution-model`, `--reasoning-effort`.

Canonical config file form (snake_case keys are also accepted):

```json
{
  "planningModel": "<planning-model-id>",
  "executionModel": "<execution-model-id>",
  "reasoningEffort": "xhigh"
}
```

Your Codex config (`~/.codex/config.toml`) is never read or written —
model/effort/endpoint reach the managed session as process-local CLI
overrides only.

## Usage

```bash
phase-model                                  # config file / env
phase-model --planning-model gpt-6-sol --execution-model gpt-6-astra
phase-model --reasoning-effort high
phase-model --no-alt-screen                  # unknown flags pass through
```

`phase-model --help` lists everything it owns. All other arguments are
passed through to the Codex TUI. A handful of startup arguments are
reserved (`--remote`, `--model`/`-m`, `-c model=…`,
`-c model_reasoning_effort=…`, `-c plan_mode_reasoning_effort=…`); passing
them through fails fast with a clear conflict error instead of silently
overriding. Runtime `/model` inside the TUI is unaffected.

## `/model` semantics

- Entering **Plan** → the configured planning model is applied.
- Entering **Default** → the configured execution model is applied.
- Running `/model X` **within the current mode** → the launcher does
  nothing; your pick is yours.
- At the **next real mode transition** → the configured model for that
  mode is applied again.

The model is **not phase-locked** — between transitions the session is
plain Codex.

## Reasoning effort semantics

`reasoningEffort` is a **startup default only**: it initializes Codex's two
native defaults (`model_reasoning_effort`, `plan_mode_reasoning_effort`) to
the same configured value. If you change effort during the session, the
launcher never corrects it.

## Failure behavior

Two independent failure domains:

- **Controller/switcher failure** (protocol error, disconnect, rejected
  model): one warning is printed, automatic switching is disabled for the
  remainder of the session, and your Codex session **continues normally**.
- **App-server failure** (the session-dedicated app-server exits): the
  managed session **terminates** (no restart, no recovery); the TUI is
  shut down and the launcher exits non-zero.

A normal TUI exit ends the managed session and the launcher returns the
TUI's exit code.

## Security / network

The dedicated app-server listens **only on `127.0.0.1`** on an
OS-assigned ephemeral port, exists only for the lifetime of one managed
session, and is reachable only from your machine. There is no LAN/remote
mode. The controller can change exactly one thing — the current thread's
model.

## Known limitations

- Depends on Codex's **experimental app-server settings surface**; future
  Codex releases may require adapter updates (no static version gate by
  design).
- A brand-new thread's settings subscription converges only after Codex
  materializes its rollout (first turn); until then model application is
  skipped for that thread and resumes automatically.
- Manual `/model` picks and manual effort changes are intentionally
  unmanaged (see semantics above). Note that on codex-cli 0.156.1 the
  `/model` dialog change is applied by the TUI at your next turn.
- No transparent app-server recovery, no auto-update, no installer.
- Validation was performed on Windows (see
  `docs/codex cli/PRE_RELEASE_READINESS.md` in the repository); macOS and
  Linux runtime validation is documented there as well.
