# Implementation notes (maintainer knowledge)

These notes are developer documentation, not user docs. They record the
codex-cli 0.156.1 protocol/behavior facts the adapter depends on and the
reasons behind non-obvious implementation decisions. The frozen
architecture lives in `docs/codex cli/spec/`; this file explains the
empirical reality underneath it.

## Thread binding: ephemeral title threads must be ignored

The real Codex TUI spawns a short-lived **thread-title generator** when the
first user message arrives on an unnamed thread
(`tui/src/app/thread_title.rs` at rust-v0.156.1). On the wire it is a
TOP-LEVEL thread:

```json
{ "parentThreadId": null, "ephemeral": true, "threadSource": "thread_title",
  "path": null, "historyMode": "legacy" }
```

`ThreadStartParams` has no parent field at all, so `parentThreadId: null`
cannot distinguish it from the conversation thread. It never persists a
rollout (`path: null` — ephemeral threads skip rollout creation), so its
subscription can never converge, and binding it would permanently hijack
the controller away from the real thread (whose settings updates would then
be ignored — switching silently dead).

The controller therefore ignores threads where
`ephemeral === true || threadSource === "thread_title"`
(`model-controller.ts`, `parseThreadStarted`). This is exact Codex
metadata, not a heuristic; absent fields (tolerant reading) keep the old
bind-everything behavior. The real conversation thread carries
`threadSource: "user"`, `ephemeral: false`, and a rollout path.

## Subscription mechanics (fresh-thread pending → idle convergence)

`thread/settings/updated` is THREAD-SCOPED: a side client receives it only
after `thread/resume {threadId}` joins the fan-out. A fresh thread rejects
resume with `-32600 "no rollout found"` until Codex materializes the rollout
(around its first turn). Controller flow: bind → one resume; that specific
rejection → `pending` (fail-open diagnostic); current-thread
`thread/status/changed(idle)` → exactly one event-driven retry; any other
resume failure → controller disabled. No timers, no polling. The switcher
additionally skips application unless the controller is `subscribed`, so
the early window is harmless.

## Passive Subscriber Rule

Once subscribed, the controller is one of possibly several subscribers of a
thread; the app-server may broadcast server-initiated requests (approval/
tool prompts) to all of them. Any JSON-RPC response from the controller
could race the authoritative TUI subscriber's answer — so incoming server
requests get **no response at all** (no -32601, no error, no empty
success). Locked by `test/passive-boundaries.test.ts` and
`test/subscription-convergence.test.ts`.

## Model writes

`thread/settings/update` takes FLAT params; the model-only form
`{threadId, model}` is accepted on 0.156.1 with mode and reasoning effort
preserved. Same-model updates are server-side no-ops and produce no echo.
Reasoning effort is NOT part of the write (Architecture SPEC §14/§17).

## TUI behavior facts (0.156.1, remote/`--remote` sessions)

- `codex --remote ws://127.0.0.1:<port>` attaches the real TUI to a
  launcher-owned app-server. `--model` and `-c model_reasoning_effort="…"`
  / `-c plan_mode_reasoning_effort="…"` coexist with `--remote` and seed
  the thread metadata + TUI header.
- The TUI requires a TTY (`stdin is not a terminal` otherwise); the E2E
  smoke drives it through node-pty (ConPTY). PTY tooling is dev/test-only
  (probe script + optional NODE_PATH), never a package dependency.
- The **`/model` dialog** is a two-stage numbered menu ("Select Model and
  Effort" → "Select Reasoning Level"). Applying a change sets the TUI's
  next-turn override; it does NOT write app-server thread settings, and no
  `thread/settings/updated` echo is broadcast for it. It may also exit Plan
  mode outright (observed once, not reproduced every run).
- **Plan mode auto-exits when a plan turn completes** (plan → execute
  workflow). A turn driven inside plan mode ends with mode=Default.
- A fresh TUI start shows an update-available modal; pressing Enter on it
  RUNS `npm install -g @openai/codex`. (Our probes dismiss it with Esc.
  The launcher never sends keystrokes itself.)
- The update modal can trigger `npm install -g @openai/codex` — an
  interrupted install corrupts the global shim. Restore with
  `npm install -g @openai/codex@<version>`.

## Launcher structure

`ManagedCodexSession` (composition root) owns the lifecycle: runtime
(owns app-server child) → controller (owns WebSocket) → switcher (owns
routing state) → TUI child (owns the terminal; its type deliberately has
no output streams, so the launcher structurally cannot read conversation
output). Fail-open failures share ONE warn-once flag; app-server exit is
terminal; SIGINT/SIGTERM do best-effort cleanup. Windows uses the
Phase 1 `cmd.exe /d /s /c codex` shim strategy for BOTH children from one
`ResolvedCodexCommand`; POSIX uses detached process groups with
SIGTERM→SIGKILL escalation.

## Validation landscape

- Offline unit/integration tests (`npm test`): fake processes, fake
  WebSocket server, no Codex, no network. Always runnable.
- Live probes (`npm run test:live`, opt-in, need real Codex + auth):
  Phase 1 smoke, Phase 3 subscription probe, Phase 4 model-switch probe,
  Phase 5 managed-TUI E2E (PTY). Current results are recorded in
  `docs/codex cli/PRE_RELEASE_READINESS.md`.
