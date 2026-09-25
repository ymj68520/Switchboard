#!/usr/bin/env node
/**
 * Live Codex app-server smoke test for the Phase Model Switcher session
 * runtime (Phase 1, directive §13).
 *
 * Uses the BUILT runtime (adapters/codex/dist) against the REAL Codex CLI:
 *
 *   1. `codex --version` is available
 *   2. spawn session-dedicated `codex app-server --listen ws://127.0.0.1:0`
 *   3. discover the OS-assigned loopback WebSocket endpoint from stderr
 *   4. GET /readyz returns HTTP 200 → runtime READY
 *   5. deterministic shutdown → child process tree gone
 *
 * Prints PASS/FAIL per criterion and exits non-zero on failure. Skips with
 * a clear message when no Codex CLI is installed (Phase 1 must not block).
 *
 * Usage: node scripts/codex-live-smoke.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeEntry = path.join(repoRoot, "adapters", "codex", "dist", "index.js");

if (!existsSync(runtimeEntry)) {
  console.error("BUILT RUNTIME MISSING — run `npm run build -w @switchboard/codex` first");
  process.exit(2);
}

const { CodexSessionRuntime } = await import(pathToFileURL(runtimeEntry).href);

const results = [];
function report(step, ok, detail = "") {
  results.push({ ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Resolve a spawnable command for the `codex` CLI. On win32 the npm shim is
 * a .cmd file, which Node refuses to spawn without a shell; route through
 * cmd.exe with an argv array (no string concatenation) so the runtime's
 * taskkill /T tree kill still covers the whole shim→binary chain.
 */
function resolveCodexLaunch() {
  if (process.platform !== "win32") {
    return { command: "codex", args: [] };
  }
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", "codex"],
  };
}

function codexVersion() {
  const { command, args } = resolveCodexLaunch();
  const probe = spawnSync(command, [...args, "--version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (probe.error || probe.status !== 0) {
    return null;
  }
  return (probe.stdout ?? "").trim() || null;
}

const version = codexVersion();
if (!version) {
  console.log("SKIP  real Codex smoke test — no usable Codex CLI on PATH");
  console.log("      (Phase 1 does not block on this; see directive §13)");
  process.exit(0);
}
console.log(`Codex CLI: ${version}`);

const { command, args } = resolveCodexLaunch();
const runtime = new CodexSessionRuntime({
  command,
  args: [...args, "app-server", "--listen", "ws://127.0.0.1:0"],
});

let endpoint = null;
try {
  // 2-3. spawn + endpoint discovery + readiness
  const startedAt = Date.now();
  endpoint = await runtime.start();
  report(
    "spawn app-server (ws://127.0.0.1:0) → OS-assigned endpoint discovered",
    true,
    `${endpoint.wsUrl} in ${Date.now() - startedAt}ms`,
  );

  // 4. /readyz
  const readyzResponse = await fetch(`${endpoint.httpBaseUrl}/readyz`);
  report(
    "GET /readyz",
    readyzResponse.status === 200,
    `HTTP ${readyzResponse.status}`,
  );
  await readyzResponse.arrayBuffer().catch(() => {});

  report("runtime state", runtime.state === "ready", `state=${runtime.state}`);

  // 5. deterministic shutdown
  const exit = await runtime.shutdown();
  report(
    "deterministic shutdown",
    runtime.state === "stopped" && exit !== null,
    `state=${runtime.state}, exit=${exit ? `code=${exit.exitCode}, signal=${exit.signal}` : "none"}`,
  );
} catch (error) {
  report("live smoke run", false, error instanceof Error ? error.message : String(error));
  try {
    if (runtime.state === "starting" || runtime.state === "ready") {
      await runtime.shutdown();
    }
  } catch {
    // best-effort cleanup; failure already reported above
  }
}

const allPass = results.length > 0 && results.every((r) => r.ok);
console.log(allPass ? "\nSMOKE RESULT: PASS" : "\nSMOKE RESULT: FAIL");
process.exit(allPass ? 0 : 1);
