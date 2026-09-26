# Pre-Release Readiness — Codex CLI Phase Model Switcher 0.0.1

Status: **pre-alpha, locally installable — NOT publicly released.**

## Baseline

| Item | Value |
| --- | --- |
| Architecture | `codex-cli-phase-model-switcher-architecture-spec-v0.0.1.md` (frozen) |
| Implementation line | `96d654c` (P1) → `0f5b4ab` (P2) → `992187d` (P3) → `923d5dc` (P4) → `8f7c4f8` (P5) → Phase 6 hardening |
| Package | `@switchboard/codex` `0.0.1` (`private`, `license: UNLICENSED`, bin `phase-model`) |
| Runtime dependencies | none (Node built-ins only; Node ≥ 22.4.0) |

## Tested environments

| Platform | Build | Offline tests | Process cleanup | Real Codex | Managed TUI E2E |
| --- | --- | --- | --- | --- | --- |
| Windows 10 21H2 (10.0.19044), Node 22.23.2, codex-cli 0.156.1, ConPTY/console | PASS | PASS (193/193) | PASS (real children, suite + probes) | PASS (4 probes, see below) | PASS (11/11) |
| Linux | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |
| macOS | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |

Linux/macOS were not executed: this machine has no Docker, no VM, and WSL
is present but both required Windows features (`VirtualMachinePlatform`,
`Microsoft-Windows-Subsystem-Linux`) are disabled — enabling them requires
a system reboot, which was not performed autonomously. **Blocker level:**
POSIX process-group cleanup validation is a **release blocker for any
public distribution** of 0.0.1 (the POSIX terminate path — detached
process groups, SIGTERM→SIGKILL — is implemented and code-reviewed but has
never executed on a real POSIX host). Per the phase classification this is
a documented pre-alpha limitation for local readiness, and macOS runtime
validation is explicitly NOT EXECUTED (not assumed PASS).

## Test counts (Windows, this baseline)

- Offline suite (`npm test`): **193/193 PASS** — unit + integration over
  fake processes/sockets; no Codex, no network, no TTY required.
- Live probes (`npm run test:live`, explicit opt-in, all re-run on this
  baseline):
  - Phase 1 app-server live smoke: **PASS**
  - Phase 3 automatic-subscription controller probe: **PASS**
  - Phase 4 model-application probe: **PASS 11/11** (step 6 adapted: with a
    local API-key login the server now starts fresh threads at the account
    default, so the initial write can be a same-model no-op with no echo —
    documented in the probe and implementation notes; not a product
    regression)
  - Phase 5 managed-TUI E2E: **PASS 11/11** (real launcher → real
    app-server → real TUI under PTY; Default→Plan→Default, manual `/model`,
    manual effort, exit codes, orphan check)

## Packaging validation

- `npm pack --dry-run`: 42 files — `bin/`, `dist/` (no source maps),
  `docs/implementation-notes.md`, `README.md`, `package.json`. No tests,
  probes, fixtures, or coverage.
- `npm pack` → `switchboard-codex-0.0.1.tgz` → installed into a clean temp
  project → `phase-model --help` via the npm shim: PASS.
- Installed-bin error paths: reserved-argument conflict → exit 2 with
  actionable message; missing model configuration → exit 2 with remediation.
- Installed-package full-chain smoke (real app-server + controller +
  switcher + real TUI spawn): PASS; the TUI's no-TTY exit propagated and
  cleanup left no processes.

## Known limitations

- Depends on Codex's **experimental app-server settings surface**; runtime
  capability verification only (no static version gate). Validated with
  codex-cli 0.156.1 — a tested environment, not a requirement floor.
- Fresh-thread subscription converges only after Codex materializes the
  rollout; model application is skipped for that window (by design).
- Manual `/model` and manual effort changes are intentionally unmanaged.
- No transparent app-server recovery (terminal by design); controller
  failure disables automation for the current session only (fail-open).
- TUI automation in the E2E probe parses live terminal output; upstream
  rendering changes can require probe updates (does not affect the product).
- With a local API-key login present, fresh driver threads start at the
  account default model (changes echo dynamics in probes — documented).

## Release blockers (for any public release)

1. POSIX process-cleanup validation NOT EXECUTED (see above) — must run on
   at least one real Linux/macOS host before public distribution.
2. No CI: offline suites must be wired into a runner or verified per release.

## Non-blocking pre-alpha limitations

macOS not validated; no installer/auto-update/public pipeline; experimental
upstream dependency; TUI automation brittleness; no static Codex
compatibility matrix.

## Publishing boundary

Nothing has been published: no `npm publish`, no GitHub release, no tag or
branch pushes. The package is `private: true`. A future **Release 0.0.1**
operation phase would only handle tag/publish/notes on top of this state.
