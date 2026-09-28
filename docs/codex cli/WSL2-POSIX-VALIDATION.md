# WSL2 POSIX Release-Gate Validation — @switchboard/codex 0.0.1

Date: 2026-09-28 · Baseline: commit `0c249ae` (frozen Phase 6 output) ·
Scope: environment bootstrap + Linux/POSIX validation only — **no product
code changed**, the frozen architecture spec and the Claude/OpenCode lines
were untouched.

## Verdict

> **POSIX LIFECYCLE GATE: PASS — WSL2 Linux.**
> All six process-cleanup correctness cases pass on a real Linux kernel
> with real POSIX process groups and signals; no managed-session orphan
> survives any controlled exit or failure path.

What this closes: the Phase 6 release blocker *"POSIX process-cleanup
validation NOT EXECUTED — must run on at least one real POSIX host"*
(criterion: at least one real POSIX environment with signal/process-group
semantics actually measured — WSL2 uses the real Linux kernel and real
POSIX process semantics).

Live model-turn coverage (closed same day): after the process gate passed,
the user **explicitly authorized** copying the Windows `~/.codex/config.toml`
(inline relay bearer token) into the WSL home plus an equivalent placeholder
API-key login (the same synthetic control-plane key documented since Phase 5;
no secret value is printed or committed). With Codex authenticated, the full
live probe suite was re-run on Linux: Phase 1 smoke 4/4, **Phase 3 probe
9/9, Phase 4 probe 11/11, Phase 5 managed-TUI E2E 11/11 — all PASS**, so
real Codex phase switching is now verified end to end on Linux, not only on
Windows.

Remaining uncovered (honest classification): **macOS is still NOT
EXECUTED** — a documented pre-alpha limitation, not assumed PASS.

## 1. Environment

| Item | Value |
| --- | --- |
| Hypervisor | WSL 2.7.14.0 (Windows 10 19044.7725), WSL **2** (not WSL1) |
| Distro | Ubuntu 24.04 LTS (Noble Numbat), freshly initialized, default user root |
| Kernel | `6.18.33.2-microsoft-standard-WSL2` (real Linux kernel) |
| Arch / CPU / RAM | x86_64 / 12 cores / 7.7 GiB |
| Filesystem | validation checkout on **native ext4** (`/dev/sdd`), not DrvFs |
| nvm | 0.40.8 (`/root/.nvm`) |
| Node / npm | v22.23.2 / 10.9.8 — both from `$HOME/.nvm/.../bin` (same Node minor as Windows) |
| Codex CLI | codex-cli **0.156.1** via `npm install -g @openai/codex@0.156.1` (same pin as Windows) |
| Codex auth | Logged in (user-authorized copy of Windows `config.toml` + placeholder API-key login; token never printed) |
| Claude Code config | `settings.json`, `plugins/`, `.claude.json` (chmod 600) copied from the Windows profile; both JSON files parse; runtime/cache dirs intentionally NOT copied |

### Environment bootstrap deviations (recorded, none product-related)

- `github.com:443` is reset on this network (git clone: GnuTLS error -110;
  direct curl: connect timeout) while `codeload.github.com`,
  `raw.githubusercontent.com`, `nodejs.org` and both npm registries are
  reachable. nvm 0.40.8 was therefore installed from the **official
  codeload tarball of the same tag** (`nvm-sh/nvm` v0.40.8) instead of the
  `install.sh` git-clone path; Node and Codex came from the pinned official
  sources unmodified.
- WSL interop (binfmt for Windows PE) was not registered at first boot
  (`cmd.exe`: Exec format error — a known systemd-distro first-boot issue).
  Fixed by registering the WSLInterop binfmt entry and persisting it via
  `/usr/lib/binfmt.d/WSLInterop.conf`; only used to resolve the Windows
  profile path for the config copy.
- `/tmp` in this distro does not survive a WSL distro restart (observed:
  the distro restarted mid-validation and `/tmp` was emptied); all
  subsequent validation state lived under `/root`.

## 2. Validation results

| Area | Result |
| --- | --- |
| Native checkout | `~/src/phase-model-posix-validation` @ `0c249ae`, worktree clean, ext4 |
| `npm ci` (root workspaces) | PASS — all three workspaces install; zero vulnerabilities |
| typecheck / lint / build | PASS / PASS / PASS |
| Offline suite (`npm test`) | **193/193 PASS** (13 files) — identical to the Windows baseline |
| `npm pack --dry-run` | PASS — 42 files, 55.7 kB, allowlist respected (bin/dist/docs/README, no tests/probes/maps) |
| Clean temp install of tarball | PASS — `added 1 package` (zero runtime deps pulled), shebang intact |
| Installed bin `--help` | PASS (exit 0) |
| Installed bin error paths | reserved-arg conflict → exit 2; missing config → exit 2 with remediation text |
| Phase 1 live app-server smoke | **PASS 4/4** (endpoint discovery 2297 ms, readyz 200, state transitions, clean shutdown) |
| Phase 3 subscription probe | **PASS 9/9** (real turns: pending→automatic convergence, default→plan→default observed, passive-subscriber non-interference, clean cleanup) |
| Phase 4 model-switch probe | **PASS 11/11** (model/list discovery gpt-6-sol/gpt-6-astra; initial no-op branch; Plan→planningModel echo-verified; manual `/model` survives; Plan→Default reapply; effort untouched) |
| Phase 5 managed-TUI E2E | **PASS 11/11** after the harness portability fix below (real TUI turns; initial executionModel + effort xhigh, plan→planningModel, manual /model + manual effort uncorrected, exit code propagation, /proc orphan sweep clean) |
| POSIX process-cleanup gate | **PASS 6/6** (below) |

## 3. POSIX process-cleanup release gate (the core evidence)

Method: `scripts/codex-posix-process-gate.mjs` (committed by this change)
drives the **installed-package** launcher
(`/root/pv-install/node_modules/.bin/phase-model` → real `codex app-server`
→ real Codex TUI under a Linux PTY, node-pty harness) through six cases,
snapshotting every managed-session process as
`pid / ppid / pgid / sid / state / cmdline` from `/proc` before, during and
after each case, and asserting **zero survivors per recorded PID plus a
zero global sweep** — not a bare `pgrep codex`-empty heuristic (§18). The
gate refuses to run on a host with pre-existing codex processes.

Process-tree shape observed per session (5 procs):
launcher (`node …/.bin/phase-model`, its own session/pgroup via forkpty) →
app-server (`node …/bin/codex app-server --listen ws://127.0.0.1:0` +
vendored native binary, own pgroup) → TUI (`node …/bin/codex --remote
ws://127.0.0.1:<port> --model … -c model_reasoning_effort=…` +
vendored native binary, own pgroup).

| Case | Trigger | Launcher exit | Survivors |
| --- | --- | --- | --- |
| A normal TUI exit | keyboard quit at the TUI (Ctrl-C) | 0 | **0** |
| B SIGINT | `kill -INT <launcher-pid>` on the live session | 1 | **0** |
| C SIGTERM | `kill -TERM <launcher-pid>` on the live session | 1 | **0** |
| D app-server crash | SIGKILL to that session's app-server PID only | 1 | **0** |
| E force-kill fallback | SIGTERM-immune child: pgroup SIGTERM ignored → pgroup SIGKILL kills | n/a | **0** |
| F bootstrap failure after app-server spawn | no TTY → `Error: stdin is not a terminal` | 1 | **0** |

Additional depth: in cases B/C/D the live app-server had spawned a `git`
grandchild (`git -C /root/.codex/.tmp/plugins-clone-* fetch --depth 1`) as
a member of the app-server **process group**; after every termination path
the sweep still reported zero processes, i.e. the group-based terminate
ladder reaches even grandchildren spawned by the native Codex binary.

Notes on case fidelity: cases A–D ran the TUI at its login screen (no
auth); the TUI, launcher and app-server process lifecycle — which is what
this gate verifies — is fully real. Case E validates the kernel mechanism
(the ladder rungs `SIGTERM pgroup → grace → SIGKILL pgroup` implemented in
`app-server-process.ts` / `tui-process.ts`); the ladder's sequencing is
pinned by the offline suite's fake stubborn-child tests. Case F proves
cleanup of an already-ready app-server when bootstrap fails after spawn.

## 4. Live-probe harness portability fix (the only code change)

The Linux run exposed **one test-harness portability defect** (directive
§19-20 scope: test harness portability; no product code touched). The Phase 5
smoke `scripts/codex-managed-tui-smoke.mjs` hard-coded three Windows-only
behaviors; each got a minimal platform branch mirroring the product's own
`resolveCodexCommand()`:

1. `discoverModels()` spawned its throwaway model-picker app-server via
   `process.env.ComSpec ?? "cmd.exe"` + cmd argv — on Linux this resolved to
   `/mnt/c/Windows/system32/cmd.exe` (appended Windows PATH) and died with
   the PE bytes interpreted as a shell script → `exited_before_endpoint`.
2. The failure-path cleanup invoked `taskkill /T /F` unconditionally —
   POSIX now uses a process-group `SIGKILL` (node-pty makes the launcher a
   session/group leader).
3. The orphan check ran `tasklist` — POSIX now sweeps `/proc/*/cmdline` for
   surviving codex/phase-model processes (excluding this script's own PID),
   the same discipline as the release gate.

With the fix: Linux Phase 5 smoke **PASS 11/11**. Because the changed file
is cross-platform, the same smoke was re-run on Windows: **PASS 11/11**
(first attempt failed on a pre-existing local environment issue — the nvm
24/22 switching had deleted the global `codex` binary; reinstalling the
pinned `@openai/codex@0.156.1` restored it, matching the known environment
gotcha recorded for this machine). No Linux-focused unit regression was
added because the defect lived entirely in a live-probe script; the offline
suite (193/193) covers the product code paths.

## 5. Release-blocker status after this validation

| Blocker (Phase 6) | Status |
| --- | --- |
| POSIX process-cleanup validation NOT EXECUTED | **CLOSED for Linux/WSL2** (this document). macOS remains NOT EXECUTED — documented pre-alpha limitation; required before any *macOS* claim, not for the POSIX gate criterion. |
| No CI | **Still open** — unchanged by this task (directive §23: no scope expansion). |

The Linux live-switching follow-up is also **CLOSED**: all four live probes
pass on Linux (§2), with the auth question settled by explicit user
authorization (§1).

## 6. Reproducing this gate

On a Linux host with the repo built and (ideally) the tarball installed
into a scratch project:

```bash
npm install --prefix .probe-deps node-pty          # dev-only PTY harness
NODE_PATH=.probe-deps/node_modules \
PHASE_MODEL_BIN=/path/to/installed/node_modules/.bin/phase-model \
  node scripts/codex-posix-process-gate.mjs
```

`PHASE_MODEL_BIN` defaults to the repo-built `adapters/codex/bin/phase-model.js`.
The gate exits non-zero on any failure or survivor and skips (exit 0) on
non-Linux hosts or without node-pty.
