# Pre-Release Readiness — Codex CLI Phase Model Switcher 0.0.1

Status: **pre-alpha, locally installable — NOT publicly released.**

## Baseline

| Item | Value |
| --- | --- |
| Architecture | `codex-cli-phase-model-switcher-architecture-spec-v0.0.1.md` (frozen) |
| Implementation line | `96d654c` (P1) → `0f5b4ab` (P2) → `992187d` (P3) → `923d5dc` (P4) → `8f7c4f8` (P5) → Phase 6 hardening |
| Package | `@switchboard/codex` `0.0.1` (`private`, `license: MIT`, bin `phase-model`) |
| Runtime dependencies | none (Node built-ins only; Node ≥ 22.4.0) |

## Tested environments

| Platform | Build | Offline tests | Process cleanup | Real Codex | Managed TUI E2E |
| --- | --- | --- | --- | --- | --- |
| Windows 10 21H2 (10.0.19044), Node 22.23.2, codex-cli 0.156.1, ConPTY/console | PASS | PASS (193/193) | PASS (real children, suite + probes) | PASS (4 probes, see below) | PASS (11/11) |
| Linux — WSL2: Ubuntu 24.04, kernel 6.18.33.2-microsoft-standard-WSL2, Node 22.23.2, codex-cli 0.156.1, native ext4 checkout | PASS | PASS (193/193) | **PASS (release gate 6/6)** | **PASS (all 4 probes, see below)** | **PASS (11/11)** |
| macOS | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |

Linux (WSL2, 2026-09-28) was validated on a freshly initialized WSL2 distro
using the real Linux kernel and real POSIX process semantics, on a native
ext4 checkout at this baseline. The dedicated POSIX process-cleanup release
gate — six termination/failure cases (normal exit, SIGINT, SIGTERM,
app-server crash, force-kill fallback, bootstrap failure after spawn) with
per-PID/PPID/PGID/SID evidence and zero-survivor assertions, including a
native-binary `git` grandchild reached by the process-group kill — is
documented in [WSL2-POSIX-VALIDATION.md](WSL2-POSIX-VALIDATION.md) and
reproducible via `scripts/codex-posix-process-gate.mjs`. After the user
explicitly authorized copying the Windows Codex relay configuration into
the WSL home (placeholder API-key login; no secret printed or committed),
all four live probes were re-run on Linux and **PASS** (Phase 1 smoke 4/4,
Phase 3 probe 9/9, Phase 4 probe 11/11, Phase 5 managed-TUI E2E 11/11 —
the latter after a POSIX-portability fix to the probe script itself,
re-verified on Windows 11/11). macOS remains NOT EXECUTED — a documented
pre-alpha limitation, not assumed PASS.

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

1. ~~POSIX process-cleanup validation NOT EXECUTED~~ **CLOSED for Linux
   (WSL2) 2026-09-28** — six-case gate PASS with zero survivors on a real
   Linux kernel (see WSL2-POSIX-VALIDATION.md). macOS runtime validation
   remains NOT EXECUTED (documented pre-alpha limitation; required before
   any macOS-specific claim).
2. No CI: offline suites must be wired into a runner or verified per release.

The Linux live-probe follow-up opened by the WSL2 validation is CLOSED:
Codex authentication was settled by explicit user authorization and all
four live probes pass on Linux (see WSL2-POSIX-VALIDATION.md §1-2).

## Non-blocking pre-alpha limitations

macOS not validated; no installer/auto-update/public pipeline; experimental
upstream dependency; TUI automation brittleness; no static Codex
compatibility matrix.

## Publishing boundary

Nothing has been published: no `npm publish`, no GitHub release, no tag or
branch pushes. The package is `private: true`. A future **Release 0.0.1**
operation phase would only handle tag/publish/notes on top of this state.
