#!/usr/bin/env node
/**
 * POSIX process-cleanup release gate for the managed Codex launcher
 * (Phase 6 directive §14-18; WSL2 validation 2026-09-28).
 *
 * Drives the REAL production chain (installed or repo-built `phase-model`
 * bin → real `codex app-server` → real Codex TUI) on a Linux/POSIX host
 * through six termination/failure cases and asserts — per recorded PID,
 * PPID, PGID and SID, not by a bare `pgrep` grep — that no managed-session
 * process survives any of them:
 *
 *   A normal managed TUI exit (keyboard quit: Ctrl-C, 'q', Ctrl-D)
 *   B launcher receives SIGINT
 *   C launcher receives SIGTERM
 *   D app-server unexpectedly exits (SIGKILL to THAT session's app-server)
 *   E force-kill fallback mechanism (SIGTERM-immune child; SIGTERM to the
 *     process group must not suffice, process-group SIGKILL must)
 *   F bootstrap failure after app-server spawn (no TTY → TUI spawn fails)
 *
 * This is a TEST/VALIDATION helper only: it spawns real processes and reads
 * /proc; it never imports production code. Requires Linux (uses /proc and
 * POSIX process groups). Requires node-pty (dev-only) resolvable via
 * NODE_PATH; without a PTY it SKIPs rather than running degraded.
 *
 * Usage:
 *   NODE_PATH=<node-pty prefix>/node_modules node scripts/codex-posix-process-gate.mjs
 *
 * Environment:
 *   PHASE_MODEL_BIN  launcher to exercise. Default: the repo-built
 *                    adapters/codex/bin/phase-model.js. Point this at an
 *                    INSTALLED package bin (…/node_modules/.bin/phase-model)
 *                    to validate the packaged artifact end to end.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PHASE_MODEL_BIN =
  process.env.PHASE_MODEL_BIN ??
  path.join(repoRoot, "adapters", "codex", "bin", "phase-model.js");
const MARKER = "managed Codex session started";
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "codex-posix-gate-"));

let pty;
try {
  pty = (await import("node-pty")).default ?? (await import("node-pty"));
} catch {
  console.log("SKIP  POSIX process gate — node-pty not resolvable");
  console.log("      install once (e.g. `npm install --prefix .probe-deps node-pty`)");
  console.log("      and run with NODE_PATH=.probe-deps/node_modules (Linux only)");
  process.exit(0);
}

if (process.platform !== "linux") {
  console.log(`SKIP  POSIX process gate — requires Linux (got ${process.platform})`);
  process.exit(0);
}

if (!fs.existsSync(PHASE_MODEL_BIN)) {
  console.error(`PREFLIGHT FAIL: launcher not found at ${PHASE_MODEL_BIN}`);
  console.error("                build first (`npm run build -w @switchboard/codex`)");
  process.exit(2);
}

// ---------------------------------------------------------------- /proc views

function readCmdline(pid) {
  try {
    return fs
      .readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .filter(Boolean)
      .join(" ");
  } catch {
    return null;
  }
}

function readStat(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    const rest = raw.slice(close + 2).split(" ");
    return { state: rest[0], ppid: Number(rest[1]), pgid: Number(rest[2]), sid: Number(rest[3]) };
  } catch {
    return null;
  }
}

function listProcs() {
  const out = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const cmd = readCmdline(pid);
    if (cmd === null || cmd === "") continue;
    out.push({ pid, cmd });
  }
  return out;
}

/**
 * Managed-session process sweep. Deliberately matches the whole codex /
 * phase-model family (launcher node proc, npm wrapper node procs, and the
 * native vendored Codex binaries) so a survivor cannot hide behind argv
 * variation. On a validation host that runs other Codex sessions, pass
 * BASELINE_NONZERO=1 to downgrade a non-empty pre-gate sweep to a warning
 * and rely on the per-PID survivor assertions instead.
 */
function findSessionProcs() {
  return listProcs()
    .filter(({ pid, cmd }) => pid !== process.pid && /phase-model|codex/.test(cmd))
    .map(({ pid, cmd }) => ({ pid, cmd, ...readStat(pid) }));
}

function snapshot(label) {
  const rows = findSessionProcs();
  console.log(`  [snapshot ${label}] ${rows.length} matching process(es)`);
  for (const r of rows) {
    console.log(
      `    pid=${r.pid} ppid=${r.ppid} pgid=${r.pgid} sid=${r.sid} state=${r.state} :: ${r.cmd.slice(0, 110)}`,
    );
  }
  return rows;
}

function assertClean(recorded, label) {
  const survivors = recorded.filter((pid) => readCmdline(pid) !== null);
  const sweep = findSessionProcs();
  const sweepIds = new Set(sweep.map((r) => r.pid));
  const stray = survivors.filter((pid) => !sweepIds.has(pid));
  if (stray.length > 0) {
    for (const pid of stray) console.log(`    zombie/unreaped pid=${pid} (cmdline still readable)`);
  }
  return { ok: survivors.length === 0 && sweep.length === 0, survivors, sweep };
}

// ---------------------------------------------------------------- helpers

function startLauncher(cwd) {
  return pty.spawn(PHASE_MODEL_BIN, ["--planning-model", "A", "--execution-model", "B"], {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd,
    env: process.env,
  });
}

function waitFor(ptyProc, test, timeoutMs, desc) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      ptyProc.removeListener?.("data", onData);
      reject(new Error(`timeout waiting for ${desc}; tail: ${JSON.stringify(buffer.slice(-300))}`));
    }, timeoutMs);
    function onData(data) {
      buffer += data;
      const hit = test(buffer);
      if (hit !== undefined && hit !== false) {
        clearTimeout(timer);
        ptyProc.removeListener?.("data", onData);
        resolve({ hit, buffer });
      }
    }
    ptyProc.on("data", onData);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function settleLauncherExit(term, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ exited: false, code: null, signal: null }), timeoutMs);
    const onExit = (a, b) => {
      clearTimeout(timer);
      const code = typeof a === "object" && a !== null ? a.exitCode : a;
      const sig = typeof a === "object" && a !== null ? a.signal : b;
      resolve({ exited: true, code, signal: sig ?? null });
    };
    term.on("exit", onExit);
  });
}

const results = [];
function report(caseName, ok, detail = "") {
  results.push({ caseName, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  case ${caseName}${detail ? ` — ${detail}` : ""}`);
}

async function freshCwd(name) {
  const cwd = path.join(SCRATCH, name);
  fs.mkdirSync(cwd, { recursive: true });
  return cwd;
}

// ---------------------------------------------------------------- cases

async function caseA() {
  console.log("== case A: normal managed TUI exit ==");
  snapshot("before");
  const term = startLauncher(await freshCwd("gate-a"));
  const launcherPid = term.pid;
  await waitFor(term, (b) => (b.includes(MARKER) ? true : undefined), 30000, MARKER);
  await sleep(1500); // let the TUI finish rendering its first screen
  const mid = snapshot("mid (session running)");
  const recorded = [...mid.map((r) => r.pid), launcherPid];
  console.log(`  launcher pid=${launcherPid}`);

  // Normal user quit attempts, in order: Ctrl-C, 'q', Ctrl-D.
  term.write("\x03");
  let exitA = await settleLauncherExit(term, 8000);
  if (!exitA.exited) {
    term.write("q");
    exitA = await settleLauncherExit(term, 6000);
  }
  if (!exitA.exited) {
    term.write("\x04");
    exitA = await settleLauncherExit(term, 6000);
  }
  await sleep(1000);
  const { ok, survivors, sweep } = assertClean(recorded, "A");
  report(
    "A normal-exit",
    ok,
    ok
      ? `launcher+TUI+app-server all gone (launcher exit code ${exitA.code})`
      : `SURVIVORS: ${survivors.join(",") || sweep.map((s) => s.pid).join(",")}`,
  );
}

async function caseSignal(sigName, caseLabel) {
  console.log(`== case ${caseLabel}: launcher receives ${sigName} ==`);
  const term = startLauncher(await freshCwd(`gate-${caseLabel.toLowerCase()}`));
  const launcherPid = term.pid;
  await waitFor(term, (b) => (b.includes(MARKER) ? true : undefined), 30000, MARKER);
  await sleep(1500);
  const mid = snapshot(`mid (session running, pre-${sigName})`);
  const recorded = [...mid.map((r) => r.pid), launcherPid];

  process.kill(launcherPid, sigName);
  const exit = await settleLauncherExit(term, 20000);
  await sleep(1500);
  const { ok, survivors, sweep } = assertClean(recorded, caseLabel);
  report(
    caseLabel,
    ok,
    ok
      ? `orderly cleanup complete (launcher exited: ${exit.exited}, code ${exit.code})`
      : `SURVIVORS: ${survivors.join(",") || sweep.map((s) => s.pid).join(",")}`,
  );
}

async function caseD() {
  console.log("== case D: app-server unexpectedly exits ==");
  const term = startLauncher(await freshCwd("gate-d"));
  const launcherPid = term.pid;
  await waitFor(term, (b) => (b.includes(MARKER) ? true : undefined), 30000, MARKER);
  await sleep(1500);
  const mid = snapshot("mid (session running)");
  const recorded = [...mid.map((r) => r.pid), launcherPid];

  const appServer = mid.find((r) => /app-server/.test(r.cmd));
  if (!appServer) {
    report("D app-server-crash", false, "could not identify the session app-server PID");
    try {
      term.kill();
    } catch {
      /* already gone */
    }
    return;
  }
  console.log(`  killing session app-server pid=${appServer.pid} (SIGKILL)`);
  process.kill(appServer.pid, "SIGKILL");
  const exit = await settleLauncherExit(term, 20000);
  await sleep(1500);
  const { ok, survivors, sweep } = assertClean(recorded, "D");
  report(
    "D app-server-crash",
    ok,
    ok
      ? `launcher detected terminal crash and cleaned up (exited: ${exit.exited}, code ${exit.code})`
      : `SURVIVORS: ${survivors.join(",") || sweep.map((s) => s.pid).join(",")}`,
  );
}

async function caseE() {
  console.log("== case E: force-kill fallback mechanism (POSIX) ==");
  // Dedicated stubborn test process: ignores SIGTERM. Validates the kernel
  // mechanism the POSIX terminate ladder relies on (SIGTERM to the process
  // group → grace period → SIGKILL to the process group). The ladder
  // sequencing itself is pinned by the offline suite (fake stubborn child).
  const stubPath = path.join(SCRATCH, "stubborn.mjs");
  fs.writeFileSync(
    stubPath,
    'process.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\nconsole.log("stubborn ready");\n',
  );
  const cp = spawn(process.execPath, [stubPath], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((r) => cp.stdout.once("data", r));
  const pid = cp.pid;
  const pgid = readStat(pid).pgid;
  snapshot("stubborn alive");
  console.log(`  stubborn pid=${pid} pgid=${pgid}`);

  process.kill(-pgid, "SIGTERM");
  await sleep(1000);
  const stillAliveAfterTerm = readCmdline(pid) !== null;
  console.log(`  after SIGTERM to pgroup: alive=${stillAliveAfterTerm} (expected true)`);

  process.kill(-pgid, "SIGKILL");
  await sleep(800);
  const killed = readCmdline(pid) === null;
  await new Promise((r) => {
    cp.once("exit", r);
    setTimeout(r, 3000);
  });
  report(
    "E force-kill",
    stillAliveAfterTerm && killed,
    stillAliveAfterTerm && killed
      ? "SIGTERM-immune child ignored the graceful rung; process-group SIGKILL killed it"
      : `term-ignored=${stillAliveAfterTerm} killed=${killed}`,
  );
}

async function caseF() {
  console.log("== case F: bootstrap failure after app-server spawn (no TTY) ==");
  snapshot("before");
  const cwd = await freshCwd("gate-f");
  // No PTY: the app-server spawns and becomes ready, then the TUI spawn
  // fails ("stdin is not a terminal") — a real bootstrap failure AFTER the
  // app-server exists, so cleanup of an already-ready app-server is proven.
  const cp = spawn(PHASE_MODEL_BIN, ["--planning-model", "A", "--execution-model", "B"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  const exitF = await new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve({ code, output: out });
    };
    const timer = setTimeout(() => finish(null), 30000);
    cp.stdout.on("data", (d) => (out += d));
    cp.stderr.on("data", (d) => (out += d));
    cp.once("exit", (code) => {
      clearTimeout(timer);
      finish(code);
    });
  });
  console.log(`  launcher output: ${JSON.stringify(exitF.output.slice(-160))}`);
  await sleep(1500);
  const sweep = findSessionProcs();
  report(
    "F bootstrap-failure",
    sweep.length === 0 && exitF.code === 1,
    `launcher exit=${exitF.code}; post-mortem processes: ${sweep.length}`,
  );
}

// ---------------------------------------------------------------- main

console.log("POSIX process-cleanup release gate — managed Codex launcher");
console.log(`launcher under test: ${PHASE_MODEL_BIN}`);
const baseline = findSessionProcs();
snapshot("baseline");
if (baseline.length > 0 && process.env.BASELINE_NONZERO !== "1") {
  console.error("PREFLIGHT FAIL: pre-existing codex/phase-model processes detected —");
  console.error("                this gate asserts on a global sweep and needs a clean host,");
  console.error("                or set BASELINE_NONZERO=1 to accept the baseline above.");
  process.exit(2);
}

const order = [
  ["A normal-exit", caseA],
  ["B SIGINT", () => caseSignal("SIGINT", "B")],
  ["C SIGTERM", () => caseSignal("SIGTERM", "C")],
  ["D app-server-crash", caseD],
  ["E force-kill", caseE],
  ["F bootstrap-failure", caseF],
];
for (const [label, fn] of order) {
  try {
    await fn();
  } catch (error) {
    report(label, false, error.message);
  }
  await sleep(500);
}

console.log("=== SUMMARY ===");
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.caseName}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`RESULT: ${failed === 0 ? "ALL PASS" : `${failed} FAILURE(S)`}`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
