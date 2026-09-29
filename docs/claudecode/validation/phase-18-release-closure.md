# Phase 18 — v0.1 Release Closure: Installed-Plugin & Cross-Platform Validation Records

Phase: 18 (v0.1 final release closure — packaging / installation / cross-platform release validation)
Date: 2026-09-29
Baseline: Phase 1–16 + A1 + A2 + Phase 17 (FROZEN/PASS, RC freeze), schema v13, 18 MCP tools
Dispositions of record: **PASS** on the release gate sequence below; final disposition in the Phase 18 completion report.

Committed release lineage:

```text
94a543e  feat(claude): add release packaging and version contract
<commit-2>  test(claude): validate installed plugin and cross-platform release  (this record)
<commit-3>  docs(claude): close phase plan v0.1 release
```

---

## 1. Version contract (§3/§4)

- Single hand-written source: `adapters/claude-code/.claude-plugin/plugin.json` → `version`.
- `src/runtime/version.ts` imports the manifest (`import ... with { type: "json" }`); `RUNTIME_NAME`/`RUNTIME_VERSION`, the MCP `serverInfo`, store migration records, `--version`, doctor, and the release manifest all derive from it. The hand-written `0.1.1` literal from the Phase 17 cache-bust fix is gone; the runtime now reports the manifest version.
- Release invariant test (`test/release-version-contract.test.ts`) pins: manifest == runtime identity; plugin name frozen as `phase-plan` (§56); semver validity; CHANGELOG `## <version>` heading; allowlist inputs exist; bundle eager-import invariants; release-manifest coherence (version, schema 13, tool count 18, artifact digest) whenever a release has been built.
- Version ladder used by validation: `0.1.0` (RC1 — all R1–R7 live tests) → `0.1.1` (RC2/final — update-channel test, then stable). SemVer-monotonic; no version reuse across different bytes.

## 2. Release pipeline (§6–§10, §53, §54)

`npm run release:claude` (`scripts/claude-release.mjs` + `scripts/claude-release-lib.mjs`) executes, in order, with FAIL on any step:

| Step | Record |
| --- | --- |
| typecheck / lint / full adapter tests | Node 24.21.0, 1051 passed + 1 skipped (see §6) |
| deterministic bundle build | esbuild single-file ESM, `dist/phase-plan-runtime.mjs` |
| allowlist staging (§7) | exactly 8 files: `.claude-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`, `skills/phase-plan/SKILL.md`, `agents/validator.md`, `dist/phase-plan-runtime.mjs`, `README.md`, `CHANGELOG.md` |
| secret + local-path scan (§8/§54) | PASS — no credentials, no developer paths, no store/secret/debug file names; abstract example paths do not misflag (test-pinned) |
| `claude plugin validate` staged (§53) | `success: true`, 0 errors / 0 warnings / 0 notes |
| deterministic archive (§9) | fixed timestamps (1980-01-01), sorted entries, 0644 attrs, fixed deflate-9, UTF-8 names, no extra fields |
| reproducible double-build (E11) | two independent stage+zip runs → byte-identical SHA-256 |
| `claude plugin validate` extracted (§10) | `success: true`, byte-compared all entries against staging |
| MCP handshake on staged bundle (§21/E21) | `serverInfo` version == manifest version; **exactly 18 tools**, names pinned in the release manifest |
| `--version` smoke (§37) | `phase-plan <v> | schema support 13 | required Node >=24.15.0` |
| marketplace materialization (§18/§47) | `release/marketplace/` with `phase-plan@<v>` → `claude plugin validate` PASS |
| release manifest (§38/§63) | `release/phase-plan-<v>-release.json`: product, version, schemaVersion 13, toolCount + tool names, Node floor, artifact SHA-256, reproducibleBuild, gitCommit, validated Claude host, test counts, build environment; no tokens/session ids/private content |

Artifact digests observed:

```text
phase-plan-0.1.0.zip  sha256 850d31c056bca706ce28b3b0411cbb1919a8d65f1f2f8373b9790b1827587c08
phase-plan-0.1.1.zip  sha256 69f5bb6b4b2df8b1376fc067aba7b01f1cfa609a18174082d524efc76bdb2b7a
```

The 0.1.1 digest is canonical: the archive content is independent of tree dirt (allowlist), so the final clean-tree build reproduces it byte-for-byte (double-build determinism proven at release time).

## 3. Real-host installed-plugin validation (§13, §15–§27, §59 R1–R10)

Environment: authenticated Claude Code **2.1.284** (host self-upgraded from 2.1.283 during the phase — see §42 record below), Windows 10 x64, Node 24.21.0, workspace `phase18-release-ws` (fresh git repo), installed via the local release-test marketplace (`phase-plan-release-test`, directory source), NO `--plugin-dir`, NO settings overlay, no hooks copied into settings.

| # | Test | Result | Evidence |
| --- | --- | --- | --- |
| R1 | Marketplace install without `--plugin-dir` | PASS | `claude plugin marketplace add` + `install phase-plan@phase-plan-release-test` → enabled, user scope, v0.1.0 |
| R2 | Discovery: skill, agent, hooks, MCP, data root | PASS | `claude plugin details`: 1 skill, 1 agent, **7 hooks**, 1 MCP server; MCP booted from the installed plugin (`mcp server 'phase-plan' v0.1.0 ready (18 tools)`); host assigned data root `~/.claude/plugins/data/phase-plan-phase-plan-release-test` (marketplace namespace — distinct from the `phase-plan-inline` dev root; §55 anticipated: no data migration performed) |
| R2b | Cold start (§51) | PASS | store created on first MCP startup (schema 13); cache-copy isolation: exactly the 8 allowlist files, 0 symlinks, 0 repo-relative imports; cold `--version` + MCP handshake direct from cache copy |
| R3 | `/phase-plan` entry, default Tool Search | PASS | UserPromptExpansion → `start_or_resume` signed by PreToolUse (`[_entryIntent, goal, _hostContext]`), PermissionRequest hook `allow` + `setMode(plan, session)` (no persisted permission setting, E39/E40), tool completed in 31 ms; run `plan_bbc3ba86…` started, binding gen 1 |
| R3b | Tool Search bypass probe (§15/E23/E24) | PASS | host log shows `ToolSearchTool: selected …` (Tool Search ACTIVE — user env sets `ENABLE_TOOL_SEARCH=true`) AND PreToolUse signed the selected calls — no bypass; no `ENABLE_TOOL_SEARCH=false` requirement |
| R4 | `get_context` / `get_state` smoke | PASS | signed, executed, correct run/workspace/binding payloads (multiple times across sessions) |
| R5 | Mandatory approval Deny → zero mutation (§22) | PASS | awaiting proposal `PROP-a1e6a0a4…` rev 1 `sha256:febddf0c…` frozen deterministically (probe playing the hook's signing role, public MCP path); model emitted `approve_proposal` with exact refs; host dialog rendered the tool's "cannot be pre-authorized" description; PermissionRequest hook `ask` ("approve_proposal requires explicit user approval."); **Deny ("No") → run still rev 2, proposal still awaiting, no commit — verified by independent signed probe** |
| R5b | Strict-schema zero-mutation denials | PASS | 6 model prepare attempts rejected with typed `MEMORY_REVISION_INVALID` codes (`source`/`statement`/`severity`/`status`/`title`/`rationale`) — every rejection zero-mutation; the packaged tool schema held the line against a non-cooperating model |
| R6 | PostToolUse observation capture (§23) | PASS | 6 observations in the installed store — `Read→source` ×4, `Glob→locator` ×2 — captured by the installed plugin's PostToolUse matcher during real TUI discovery; observation `tool_use_id`s match the session's real calls (host does not debug-log PostToolUse invocations; store rows are the trace) |
| R7 | MCP restart/reconnect | PASS | MCP child killed mid-session; next phase-plan tool call (`get_context`) completed in 43 ms (host respawned the server) |
| R8 | Plugin update N→N+1 (§24/§25/§46) | PASS | `claude plugin marketplace update` + `claude plugin update` → "updated from 0.1.0 to 0.1.1"; new cache dir `0.1.1` (8 files, 0 symlinks); relaunched session served `serverInfo v0.1.1` with 18 tools (**E29/§5: new release → new serverInfo → new tool schema**) |
| R9 | Old data survives update (E30/E31/E32) | PASS | before/after: `store_id c0f06df4…` identical, `host-context.key` sha256 identical, schema 13, run history (rev 2) + observations intact |
| R10 | Uninstall / reinstall data behavior (§27) | PASS | uninstall preserved the data root (empirical host fact); store integrity ok after uninstall; reinstall re-enabled the plugin; doctor READY against the same store |

Additional live-host facts recorded (harness-level, non-blocking):

- Multi-session authority on the installed plugin: a fresh session receives `selection_required` (never attaches silently) and takeover requires an explicit authorized dialog — exercised through two live takeovers (binding generation 1→2→4 observed with generation fencing intact).
- Durability across hard kills: two TUI kills left the run, its capsule state, and the awaiting proposal intact (A1 semantics on the installed plugin).
- §42/E33 capability-proof portability observed LIVE: the host's self-upgrade 2.1.283 → 2.1.284 invalidated the recorded proofs — `planModeIntegration`, `hookLifecycle` became UNKNOWN (non-blocking) until re-proving, exactly the designed behavior.
- §16/E38 settings attribution: the only user-settings changes across the phase are the host plugin-manager's own registry keys (`extraKnownMarketplaces`, `enabledPlugins`) written by the `claude plugin` CLI. The Phase Plan runtime has **zero** `settings.json` references in the bundle (grep-verified) and never writes user/project settings. No `defaultMode` persistence.
- Host fact: directory-sourced marketplaces load the plugin **in place** from the marketplace directory after update (message recorded verbatim in §8 of the release pipeline run); archive/cache installs get a version-keyed cache copy (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`). Both shapes were isolation-verified.
- Host fact: Claude Code's debug log does not record PostToolUse hook invocations (PreToolUse/PermissionRequest are logged); store observation rows are the authoritative trace.
- Harness note: the PTY control harness's ANSI-stripped screen could not render approval dialogs in the 0.1.1 sessions; dialog answers were keyed blind, synchronized on the host debug log's `executePermissionRequestHooks` events — a test-harness limitation, not a product behavior.

## 4. Doctor as release surface (§12–§14, §37, §43–§45)

- §12: doctor reports Phase Plan version, Node detected/required, `node:sqlite`, Claude Code version + capability policy, plugin environment (CLAUDE_PLUGIN_ROOT/CLAUDE_PLUGIN_DATA/CLAUDE_PROJECT_DIR/session), plugin-data writability, Plan Store schema, capability proofs; read-only (no migrate/repair/mutation, no secrets — pre-existing frozen guarantees, re-verified).
- §13: installed-plugin mode verified against the REAL installed data root: `STORE READY schema=13`, Overall READY (§44/E35).
- §43/E34: fresh install → `STORE ABSENT — initialized on first MCP startup`, NOT_INITIALIZED (never "corruption"); store created on first MCP boot.
- §45/E37: isolated corrupt copy → stable `STORE INVALID` FAIL; schema-bumped copy (14) → `STORE TOO_NEW schema=14 > supported 13 — upgrade the plugin; the store was left untouched`; original store verified untouched (schema 13, integrity ok). No automatic reset ever.
- §14/E36: on Node 22.23.2 (< 24.15 floor), measured live: `--version` still prints the banner (exit 0); `doctor` runs and reports `node FAIL — detected 22.23.2 is below the required 24.15.0` with overall NOT READY; `mcp` fails closed `UNSUPPORTED_NODE_VERSION` (exit 3). Made possible by moving `node:sqlite` out of the bundle's eager import graph (`createRequire` capture in the store connection factory; single choke point), with a release test pinning the invariant ("no top-level `node:sqlite` import in the bundle").
- §37: `--version` / `-v` / `version` prints exactly the release identity (name, version, schema floor, Node floor) and nothing environmental.

## 5. Cross-platform matrix (§28–§31, §60)

| Platform | Scope executed | Result |
| --- | --- | --- |
| Windows 10 x64 (10.0.19044), Node 24.21.0 | FULL: typecheck/lint/1051 tests, release build, plugin validate (staged+extracted), MCP handshake, marketplace install + R1–R10 live authenticated-host suite, doctor all paths, Node 22 regression | PASS |
| Linux x64 (WSL2 Ubuntu 24.04, native Node v24.21.0 linux-x64) | Runtime matrix: artifact extraction, `--version`, doctor (POSIX paths, fresh-store semantics), cold MCP (serverInfo 0.1.1, 18 tools, pure stdout), store init/reopen, `node:sqlite` backup, `host-context.key` mode 0600, warm start; typecheck/lint/full test suite; canonical-artifact verify | PASS (runtime matrix + verify); test suite result in §6 |
| macOS arm64 | No authenticated macOS host and no macOS runtime environment is available in this closure environment. NOT EXECUTED — recorded honestly per §28 ("如果不可获得，不得伪造"). The CI matrix (§7) defines the macOS arm64 gate for hosted execution; no per-platform binary exists (no native addons, E48), and the artifact is byte-identical across hosts by construction. | NOT EXECUTED (documented gap) |

Same-canonical-artifact rule (§34/E44): the Windows-built `phase-plan-0.1.1.zip` was extracted and verified on Linux — bundle sha256 identical (`7f5f23bf802a…` on both), version banner, doctor, and MCP handshake all green via `scripts/claude-release-verify.mjs` on both hosts.

### Linux test-suite triage (§61 discipline)

The first full Linux suite run produced 39 failures; each was classified before any release step proceeded:

- **36 timeout-class** (store-migration suites, phase17 matrix, run-control, synthesis-input): every failing test PASSES in isolation (e.g. `store-migration-v2` "migrates a real schema-1 store" 14.1 s standalone vs >20 s under suite parallelism). The suites intentionally wait out real SQLite busy-timeout windows; the frozen `testTimeout: 20000` was a contention floor, not a behavior signal. Harness fix: `testTimeout` raised to 60000 with the rationale in `vitest.config.ts`; Linux gate runs use `--maxWorkers=2` on constrained VMs. No product change.
- **1 test-harness defect, fixed**: `test/phase9-helpers.ts` `sourceEvent()` joined the workspace root onto an already-absolute path. On POSIX that fabricated an in-workspace path to a nonexistent file, so the §13 outside-workspace test failed at promotion (`EVIDENCE_SOURCE_FINGERPRINT_UNAVAILABLE`); on Windows the same call "passed" only by an accident of win32 path semantics (the drive-colon segment survived relativization and stat'ed the real file). The helper now passes absolute paths through verbatim. **Not a product bug** — the capture/promotion/revalidation behavior under test is correct on both platforms; the §13 fail-closed semantics now verified identically on both.
- **1 test-harness defect, fixed**: `test/release-artifact.test.ts` used `tar` for POSIX extraction of the deterministic zip; GNU tar cannot read zip archives. Now extracts via `python3 -m zipfile` on POSIX (Windows keeps bsdtar).
- **1 environment fact**: the Linux doctor marks `claude.cli` FAIL (no claude binary on a bare Linux box) → Overall NOT READY with the precise diagnosis; the verify script asserts on the JSON report, not the exit code.

After the two harness fixes the Linux full suite is **green**: 1051 passed + 1 skipped (82 files, `--maxWorkers=2`, WSL2), with typecheck and lint clean. Windows re-run with the same two fixes: no regression (§6).

## 6. Full regression (§58)

| Suite | Environment | Result |
| --- | --- | --- |
| Claude adapter suite | Node 24.21.0 (Windows) | 1051 passed + 1 skipped (82 files) — was 1028+1 at Phase 17 freeze; +23 release/packaging tests, none lost |
| Claude adapter suite | Node 22.23.2 (Windows, development regression) | 1051 passed + 1 skipped |
| Claude adapter suite | Node v24.21.0 (Linux, WSL2, `--maxWorkers=2`) | 1051 passed + 1 skipped (typecheck + lint clean) |
| OpenCode adapter suite | Node 24.21.0 (Windows) | 650 passed (25 files) — unchanged from frozen baseline |

## 7. CI (§33/§34)

`.github/workflows/phase-plan-release.yml` defines the release-oriented matrix: three-platform Node 24.21.0 quality gates; a single canonical Linux release build (`npm run release:claude`) with artifact upload; Windows + macOS verify jobs that digest-check, extract, and runtime-verify the SAME artifact; and an immutable-version job (two full release builds must produce identical digests — `IMMUTABLE_RELEASE_VERSION_VIOLATION` otherwise). CI execution requires the hosted runner environment; it was committed and its steps were executed locally on Windows and Linux (quality gates + verify script), but **no hosted CI run is claimed**.

## 8. Blocker classification (§61)

| Class | Count | Items |
| --- | --- | --- |
| RELEASE_BLOCKER | 0 | — |
| HOST_COMPATIBILITY_BLOCKER | 0 | — |
| PLATFORM_BLOCKER | 0 | macOS arm64 runtime/host validation NOT EXECUTED (environment unavailable) — recorded as a documented gap with the CI gate defined, per §28's no-fabrication rule; classified non-blocking for the Windows + Linux validated installation path. |
| DOCUMENTATION_BLOCKER | 0 | — |
| NON_BLOCKING_HOST_FACT | 5 | directory-marketplace in-place loading; data-root namespace per install identity; PostToolUse not debug-logged; capability proofs invalidated on host self-upgrade (designed); no `claude` CLI probe on bare Linux doctor (required-check FAIL, honest NOT READY) |
| CORE_CORRECTNESS_BUG / AUTHORITY_BUG / STORE_ATOMICITY_BUG | 0 | none found; product semantics, schema (13), and tool surface (18) unchanged throughout |

## 9. Exit-gate summary (§64)

E1–E8, E13–E35, E38–E42, E44–E47, E49–E65: PASS (evidence in §1–§7 above).
E43 (macOS arm64): NOT EXECUTED — documented gap, see §8.
E36 PASS with live Node 22 measurement; E48 PASS (bundle contains no native addons — pure JS + Node built-ins); E50 PASS (cache copy isolation on both 0.1.0 and 0.1.1); E51 PASS (cold start, no build/npm step); E52 PASS (warm start against real v13 history — R9 + Linux warm start); E53 PASS (R8); E54 PASS (deterministic double-build + CI immutable-version job); E55 PASS (README downgrade statement + STORE_SCHEMA_TOO_NEW fail-closed); E56 PASS (R10 empirical record).
