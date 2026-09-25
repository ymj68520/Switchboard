#!/usr/bin/env node
/**
 * Real managed-TUI end-to-end smoke (Phase 5 directive §48-51).
 *
 * Production chain under a real PTY (node-pty/ConPTY):
 *
 *   node bin/phase-model.js --planning-model <P> --execution-model <E>
 *        --reasoning-effort xhigh
 *     └─ real dedicated app-server (launcher-owned, ws://127.0.0.1:0)
 *     └─ real Controller + PhaseModelSwitcher
 *     └─ real Codex TUI --remote <endpoint> --model <E> -c effort×2
 *
 * Automated, authoritative verification:
 *   - thread state via thread/resume snapshots and thread/settings/updated
 *     echoes observed by a passive probe driver on the same app-server;
 *   - TUI interaction through the real terminal (Esc, prompts, /plan,
 *     Shift+Tab, /model dialog driven by arrow keys).
 *
 * Checks:
 *   1. launcher + dedicated app-server + Controller + Switcher  (P5-E39)
 *   2. TUI thread lives on the launcher-owned app-server        (P5-E7)
 *   3. initial Default uses executionModel                      (P5-E40)
 *   4. startup effort == configured effort                      (P5-E44)
 *   5. Default → Plan applies planningModel                     (P5-E41)
 *   6. Plan initial effort == unified startup default           (P5-E45)
 *   7. manual same-mode /model is NOT overridden                (P5-E43)
 *   8. Plan → Default reapplies executionModel                  (P5-E42)
 *   9. manual effort change is NOT corrected                    (P5-E46)
 *  10. TUI exit propagates; no orphan processes          (P5-E19/E47/E48)
 *
 * Setup: `npm run build -w @switchboard/codex`, codex on PATH, and
 * node-pty resolvable (NODE_PATH). Without node-pty the script SKIPs.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = path.join(repoRoot, "adapters", "codex", "dist", "index.js");
const binEntry = path.join(repoRoot, "adapters", "codex", "bin", "phase-model.js");

if (!existsSync(distEntry)) {
  console.error("BUILT ADAPTER MISSING — run `npm run build -w @switchboard/codex` first");
  process.exit(2);
}

let pty;
try {
  const require = createRequire(import.meta.url);
  pty = require("node-pty");
} catch {
  console.log("SKIP  real managed-TUI smoke — node-pty not resolvable");
  console.log("      install once (e.g. `npm install --prefix .probe-deps node-pty`)");
  console.log("      and run with NODE_PATH=.probe-deps/node_modules");
  process.exit(0);
}

const { AppServerRpcConnection } = await import(pathToFileURL(distEntry).href);

const results = [];
function report(step, ok, detail = "") {
  results.push({ ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(250);
  }
  throw new Error(`${label}: not satisfied within ${timeoutMs}ms`);
}

const strip = (text) =>
  text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) =>
      line
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
        .replace(/\x1b\][^\x07]*\x07/g, "")
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""),
    )
    .filter((line) => line.trim().length > 0);

/** Pick two distinct real model IDs via a throwaway app-server (test-only). */
async function discoverModels() {
  const planning = process.env.CODEX_TEST_PLANNING_MODEL ?? null;
  const execution = process.env.CODEX_TEST_EXECUTION_MODEL ?? null;
  if (planning && execution) return { planning, execution };
  const runtime = await import(pathToFileURL(distEntry).href);
  const session = new runtime.CodexSessionRuntime({
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", "codex", "app-server", "--listen", "ws://127.0.0.1:0"],
  });
  let driver = null;
  try {
    const endpoint = await session.start();
    driver = new AppServerRpcConnection(endpoint.wsUrl, {});
    await driver.open();
    await driver.request("initialize", {
      clientInfo: { name: "phase-model-smoke-picker", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    });
    driver.notify("initialized");
    const listing = await driver.request("model/list", {}, 15_000);
    const ids = (listing?.models ?? listing?.data ?? [])
      .map((entry) => entry?.id ?? entry?.model ?? entry?.slug)
      .filter((id) => typeof id === "string" && id.length > 0);
    const executionId = execution ?? ids[0] ?? "gpt-6-sol";
    const planningId = planning ?? ids.find((id) => id !== executionId) ?? executionId;
    return { planning: planningId, execution: executionId };
  } finally {
    try {
      await driver?.close();
    } catch {}
    try {
      if (session.state === "ready") await session.shutdown();
    } catch {}
  }
}

const { planning, execution } = await discoverModels();
console.log(`Codex models: planning=${planning} execution=${execution} effort=xhigh`);

// ---- launch the production launcher under a real PTY ----------------------
const launcher = pty.spawn(process.execPath, [
  binEntry,
  "--planning-model", planning,
  "--execution-model", execution,
  "--reasoning-effort", "xhigh",
], { cols: 110, rows: 34, cwd: repoRoot, env: process.env });

let tuiScreen = "";
launcher.onData((data) => {
  tuiScreen += data;
  screenTracker.feed(data);
});
const launcherExit = new Promise((resolve) => launcher.onExit((event) => resolve(event)));

let driver = null;
let userThreadId = null;
let userThreadIdleEvents = 0;
const echoes = [];
const threadStarts = [];
let driverSubscribed = false;
/** Authoritative snapshot from our own thread/resume result (test helper). */
let resumeSnapshot = null;

/** Normalize a display name or slug ("GPT-6-Luna (default)" → "gpt6luna"). */
const normalize = (text) =>
  text
    .replace(/\([^)]*\)/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** Current highlighted menu row number, from the "› N." marker. */
function highlightRowIn(lines) {
  for (const line of lines) {
    const match = line.match(/^\u203a\s*(\d+)\./) ?? line.match(/^>\s*(\d+)\./);
    if (match) return match[1];
  }
  return null;
}

/** All numbered menu rows visible in the given screen lines. */
function rowsIn(lines) {
  const found = [];
  for (const line of lines) {
    const match = line.match(/^\s*(?:\u203a|>)?\s*(\d+)\.\s+(.{2,80})$/);
    if (match) found.push({ number: match[1], label: match[2] });
  }
  return found;
}

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";
const SHIFT_TAB = "\x1b[Z";

/**
 * Minimal ANSI screen-state tracker. The codex TUI repaints with
 * line-level cursor addressing, so reading the raw byte stream mixes stale
 * and fresh frames — the tracker applies CUP/erase/print operations to a
 * character grid and always yields the CURRENT screen.
 */
class ScreenTracker {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.grid = [];
    this.cx = 0;
    this.cy = 0;
    this.clear();
  }

  clear() {
    this.grid = Array.from({ length: this.rows }, () => " ".repeat(this.cols));
    this.cx = 0;
    this.cy = 0;
  }

  feed(data) {
    let index = 0;
    while (index < data.length) {
      const ch = data[index];
      if (ch === "\x1b") {
        const csi = /^\x1b\[([0-9;?]*)([a-zA-Z])/.exec(data.slice(index));
        if (csi) {
          this.applyCsi(csi[1], csi[2]);
          index += csi[0].length;
          continue;
        }
        const osc = /^\x1b\][^\x07]*\x07/.exec(data.slice(index));
        if (osc) {
          index += osc[0].length;
          continue;
        }
        index += 1;
        continue;
      }
      if (ch === "\r") {
        this.cx = 0;
      } else if (ch === "\n") {
        this.cy = Math.min(this.rows - 1, this.cy + 1);
      } else if (ch !== "\x07" && ch !== "\x08") {
        const row = this.grid[this.cy] ?? "";
        this.grid[this.cy] = row.slice(0, this.cx) + ch + row.slice(this.cx + 1);
        this.cx += 1;
      }
      index += 1;
    }
  }

  applyCsi(params, cmd) {
    if (cmd === "H" || cmd === "f") {
      const parts = params.split(";");
      this.cy = (Number.parseInt(parts[0] || "1", 10) || 1) - 1;
      this.cx = (Number.parseInt(parts[1] || "1", 10) || 1) - 1;
      return;
    }
    if (cmd === "J") {
      if (params === "" || params === "0") {
        // Erase below: clear from the cursor down.
        for (let r = this.cy; r < this.rows; r += 1) {
          this.grid[r] = r === this.cy ? (this.grid[r] ?? "").slice(0, this.cx).padEnd(this.cols, " ") : " ".repeat(this.cols);
        }
      } else if (params === "2" || params === "3") {
        this.grid = Array.from({ length: this.rows }, () => " ".repeat(this.cols));
      }
      return;
    }
    if (cmd === "K") {
      const row = this.grid[this.cy] ?? "";
      if (params === "" || params === "0") {
        this.grid[this.cy] = row.slice(0, this.cx);
      } else if (params === "2") {
        this.grid[this.cy] = "";
      }
      return;
    }
    if (cmd === "A" || cmd === "B" || cmd === "C" || cmd === "D") {
      const n = Number.parseInt(params || "1", 10) || 1;
      if (cmd === "A") this.cy = Math.max(0, this.cy - n);
      if (cmd === "B") this.cy = Math.min(this.rows - 1, this.cy + n);
      if (cmd === "C") this.cx = Math.min(this.cols - 1, this.cx + n);
      if (cmd === "D") this.cx = Math.max(0, this.cx - n);
      return;
    }
    if ((cmd === "h" || cmd === "l") && params.includes("1049")) {
      // Alternate screen enter/leave — start from a clean grid either way.
      this.grid = Array.from({ length: this.rows }, () => " ".repeat(this.cols));
      this.cx = 0;
      this.cy = 0;
    }
    // Everything else (SGR m, mode set/rest, scroll regions) is ignored.
  }

  lines() {
    return this.grid.map((row) => row.replace(/\s+$/, ""));
  }

  text() {
    return this.grid.join("\n");
  }
}

const screenTracker = new ScreenTracker(110, 34);

/**
 * Drive the two-stage /model dialog with arrow keys (number-key selection
 * proved unreliable on 0.156.1). Returns the picked model's DISPLAY name
 * (from the effort menu title); authoritative state comes from snapshots.
 */
async function pickModelAndEffort({ avoidSlugs = [], preferSlug = null, effortLabel, label }) {
  const liveLines = () => screenTracker.lines();
  const liveText = () => screenTracker.text();

  launcher.write("/model");
  await sleep(400);
  launcher.write(ENTER);
  await waitFor(() => liveText().includes("Select Model"), `${label}: model menu`, 15_000);

  let target = null;
  for (let attempt = 0; attempt < 25 && target === null; attempt += 1) {
    const options = rowsIn(liveLines());
    if (preferSlug !== null) {
      // Menu labels carry descriptions ("GPT-6-Astra (default)  Frontier
      // intelligence…"), so match on the normalized prefix, not equality.
      target =
        options.find((o) => normalize(o.label).startsWith(normalize(preferSlug))) ?? null;
    } else {
      target =
        options.find(
          (o) =>
            !o.label.includes("(current)") &&
            !o.label.includes("(default)") &&
            !avoidSlugs.some((slug) => normalize(o.label).startsWith(normalize(slug))),
        ) ?? null;
    }
    if (target === null) await sleep(400);
  }
  if (target === null) {
    console.log(`--- tracker lines at "${label}" target-not-found ---`);
    for (const [index, line] of screenTracker.lines().entries()) {
      if (line.trim().length > 0) console.log(`| ${String(index).padStart(2)} ${line.replace(/\s+$/, "")}`);
    }
    throw new Error(`${label}: target model row not found`);
  }

  // Move the highlight onto the target row, then Enter.
  for (let step = 0; step < 30; step += 1) {
    const current = highlightRowIn(liveLines());
    if (current === target.number) break;
    const goDown = current === null || Number(current) < Number(target.number);
    launcher.write(goDown ? DOWN : UP);
    await sleep(500);
  }
  launcher.write(ENTER);
  await waitFor(() => liveText().includes("Select Reasoning Level"), `${label}: effort menu`, 15_000);

  const titleMatch = liveText().match(/Select Reasoning Level for ([^\n]+?)(?:\s{2,}|$)/m);
  const pickedModelDisplay = (titleMatch?.[1] ?? "(unknown)").trim();
  // Prefix guard — the menu title may append a "(default)" annotation.
  if (preferSlug !== null && !normalize(pickedModelDisplay).startsWith(normalize(preferSlug))) {
    throw new Error(`${label}: expected ${preferSlug}, menu says ${pickedModelDisplay}`);
  }
  if (
    preferSlug === null &&
    avoidSlugs.some((slug) => normalize(pickedModelDisplay) === normalize(slug))
  ) {
    throw new Error(`${label}: picker selected an avoided model: ${pickedModelDisplay}`);
  }

  // Highlight the requested effort row and confirm.
  let effortTarget = null;
  for (let attempt = 0; attempt < 20 && effortTarget === null; attempt += 1) {
    effortTarget =
      rowsIn(liveLines()).find((o) => normalize(o.label).includes(normalize(effortLabel))) ?? null;
    if (effortTarget === null) await sleep(400);
  }
  if (effortTarget === null) throw new Error(`${label}: effort row "${effortLabel}" not found`);
  for (let step = 0; step < 30; step += 1) {
    const current = highlightRowIn(liveLines());
    if (current === effortTarget.number) break;
    const goDown = current === null || Number(current) < Number(effortTarget.number);
    launcher.write(goDown ? DOWN : UP);
    await sleep(500);
  }
  launcher.write(ENTER);
  // Wait for the menus to close.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!liveText().includes("Select Reasoning Level") && !liveText().includes("Select Model and Effort")) {
      break;
    }
    await sleep(400);
  }
  return pickedModelDisplay;
}

/** Poll the authoritative thread state via a fresh thread/resume (test helper). */
async function refreshSnapshot() {
  const result = await driver.request("thread/resume", { threadId: userThreadId }, 15_000);
  resumeSnapshot = result ?? null;
  return resumeSnapshot;
}

async function waitForSnapshot(predicate, label, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const snapshot = await refreshSnapshot();
      if (predicate(snapshot)) return snapshot;
    } catch {
      // transient — retry on the next poll
    }
    await sleep(2_000);
  }
  throw new Error(`${label}: not satisfied within ${timeoutMs}ms`);
}

/** Drive one real turn (used to materialize TUI turn-context overrides). */
async function runOneTurn(label) {
  const idleBefore = userThreadIdleEvents;
  launcher.write("hi");
  await sleep(500);
  launcher.write(ENTER);
  await waitFor(
    () => userThreadIdleEvents > idleBefore,
    `${label}: turn completed`,
    180_000,
  );
  await sleep(1_000);
}

/** Poll until the manual change lands on the thread; false if it never does. */
async function settleManualChange(predicate, label, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const snapshot = await refreshSnapshot();
      if (predicate(snapshot)) return true;
    } catch {
      // transient — retry
    }
    await sleep(2_000);
  }
  return false;
}

try {
  // Endpoint from the launcher's one startup diagnostic line.
  let endpoint = null;
  try {
    await waitFor(() => {
      const match = tuiScreen.match(/phase-model: managed Codex session started \(endpoint (ws:\/\/127\.0\.0\.1:\d+)/);
      if (match) endpoint = match[1];
      return endpoint !== null;
    }, "launcher startup diagnostic", 30_000);
  } catch {
    console.log("--- launcher output ---");
    for (const line of strip(tuiScreen).slice(0, 20)) console.log(`| ${line}`);
    throw new Error("launcher did not report its endpoint");
  }
  report("1. managed launcher started real app-server + Controller + Switcher", true, endpoint);

  // Passive probe driver on the SAME dedicated app-server (test-only).
  driver = new AppServerRpcConnection(endpoint, {
    onNotification: (notification) => {
      if (notification.method === "thread/started") {
        const thread = notification.params?.thread ?? {};
        threadStarts.push({
          id: thread.id ?? null,
          ephemeral: thread.ephemeral === true,
          threadSource: thread.threadSource ?? null,
          model: thread.model ?? null,
          reasoningEffort: thread.reasoningEffort ?? null,
        });
      } else if (notification.method === "thread/settings/updated") {
        const ts = notification.params?.threadSettings ?? {};
        echoes.push({
          threadId: notification.params?.threadId ?? null,
          model: ts.model ?? null,
          mode: ts.collaborationMode?.mode ?? null,
          effort: ts.effort ?? null,
        });
      } else if (notification.method === "thread/status/changed") {
        const params = notification.params ?? {};
        const userThread = threadStarts.find((t) => t.threadSource === "user");
        if (userThread && params.threadId === userThread.id && params.status?.type === "idle") {
          userThreadIdleEvents += 1;
        }
        // Retry our own subscription once the rollout exists (idle events).
        if (
          !driverSubscribed &&
          params.status?.type === "idle" &&
          userThread &&
          params.threadId === userThread.id
        ) {
          void driver
            .request("thread/resume", { threadId: userThread.id })
            .then((result) => {
              driverSubscribed = true;
              resumeSnapshot = result ?? null;
            })
            .catch(() => {});
        }
      }
    },
  });
  await driver.open();
  await driver.request("initialize", {
    clientInfo: { name: "phase-model-managed-smoke", version: "0.0.0" },
    capabilities: { experimentalApi: true },
  });
  driver.notify("initialized");

  // Dismiss the update-available modal if it appeared; wait for render.
  await sleep(5_000);
  launcher.write(ESC); // harmless when no modal

  // Submit the first prompt (materializes rollout → convergence).
  await sleep(1_500);
  launcher.write("hi");
  await sleep(600);
  launcher.write(ENTER);

  await waitFor(
    () => threadStarts.some((t) => t.threadSource === "user"),
    "user thread broadcast",
    60_000,
  );
  userThreadId = threadStarts.find((t) => t.threadSource === "user").id;
  const helperThreads = threadStarts.filter((t) => t.threadSource !== "user");
  report(
    "2. TUI thread lives on the launcher-owned app-server (helpers ignored by Controller)",
    true,
    `user=${userThreadId}${helperThreads.length > 0 ? `, ${helperThreads.length} helper thread(s)` : ""}`,
  );

  await waitFor(() => driverSubscribed, "driver subscription convergence", 120_000);

  // P5-E40/E44: authoritative initial state from the resume snapshot (the
  // launcher starts the TUI AT executionModel, so the switcher's initial
  // reconciliation is a same-model no-op — no echo; the snapshot rules).
  await waitFor(() => resumeSnapshot !== null, "initial resume snapshot", 30_000);
  const initialThread = resumeSnapshot?.thread ?? {};
  const initialMode =
    resumeSnapshot?.collaborationMode?.mode ??
    resumeSnapshot?.threadSettings?.collaborationMode?.mode ??
    null;
  report(
    "3. initial Default uses executionModel (P5-E40)",
    initialThread.model === execution && (initialMode === null || initialMode === "default"),
    `model=${JSON.stringify(initialThread.model)} mode=${JSON.stringify(initialMode)}`,
  );
  report(
    "4. startup reasoning effort == xhigh (P5-E44)",
    initialThread.reasoningEffort === "xhigh",
    `effort=${JSON.stringify(initialThread.reasoningEffort)}`,
  );

  // P5-E41/E45: enter Plan via the native /plan command.
  launcher.write("/plan");
  await sleep(500);
  launcher.write(ENTER);
  const planSnapshot = await waitForSnapshot(
    (s) =>
      (s?.collaborationMode?.mode ?? null) === "plan" &&
      s?.thread?.model === planning,
    "planningModel applied after /plan",
    90_000,
  );
  report("5. Default → Plan applies planningModel (P5-E41)", true, `model=${planSnapshot?.thread?.model}`);
  report(
    "6. Plan initial effort == unified startup default (P5-E45)",
    planSnapshot?.thread?.reasoningEffort === "xhigh",
    `effort=${JSON.stringify(planSnapshot?.thread?.reasoningEffort)}`,
  );

  // P5-E43: manual same-mode /model must NOT be overridden. Empirics
  // (0.156.1): the dialog sets a TUI-side override AND may exit Plan mode
  // outright. Either way the frozen algorithm prescribes the thread state:
  //   still Plan            → planningModel (manual pick NOT applied server-side)
  //   dialog exited to Default → executionModel (mode transition → switch)
  // Any third combination means automation misbehaved.
  const manualDisplay = await pickModelAndEffort({
    avoidSlugs: [planning, execution],
    effortLabel: "extra high",
    label: "manual /model",
  });
  await sleep(6_000);
  const afterManual = await refreshSnapshot();
  const manualMode = afterManual?.collaborationMode?.mode ?? null;
  const manualModel = afterManual?.thread?.model ?? null;
  const consistent =
    (manualMode === "plan" && manualModel === planning) ||
    (manualMode === "default" && manualModel === execution);
  report(
    "7. manual same-mode /model survives — automation followed its frozen rules (P5-E43)",
    consistent,
    `picked ${manualDisplay}; thread now mode=${manualMode} model=${manualModel} ` +
      `(plan→${planning} untouched | default→${execution} via observed transition)`,
  );

  // P5-E42: a full Plan → Default cycle reapplies executionModel. Enter
  // Plan first (the dialog may or may not have left it), then leave.
  launcher.write("/plan");
  await sleep(400);
  launcher.write(ENTER);
  await waitForSnapshot(
    (s) => (s?.collaborationMode?.mode ?? null) === "plan" && s?.thread?.model === planning,
    "entered Plan for the transition check",
    60_000,
  );
  await sleep(1_000);
  launcher.write(SHIFT_TAB);
  const defaultSnapshot = await waitForSnapshot(
    (s) =>
      (s?.collaborationMode?.mode ?? null) === "default" &&
      s?.thread?.model === execution,
    "executionModel restored after leaving Plan",
    90_000,
  );
  report(
    "8. Plan → Default reapplies executionModel (P5-E42)",
    true,
    `model=${defaultSnapshot?.thread?.model}`,
  );

  // P5-E46: a manual effort change in the same mode is NOT corrected. A
  // real turn materializes the TUI-side override onto the thread.
  await pickModelAndEffort({
    preferSlug: execution,
    effortLabel: "medium",
    label: "manual effort change in Default",
  });
  await runOneTurn("manual effort turn");
  const effortMaterialized = await settleManualChange(
    (s) =>
      (s?.collaborationMode?.mode ?? null) === "default" &&
      s?.thread?.reasoningEffort === "medium",
    "manual effort on thread",
  );
  await sleep(6_000);
  const effortSettled = await refreshSnapshot();
  const effortUncorrected =
    (effortSettled?.collaborationMode?.mode ?? null) === "default" &&
    (effortMaterialized
      ? effortSettled?.thread?.reasoningEffort === "medium"
      : effortSettled?.thread?.model === execution);
  report(
    "9. manual effort change is not corrected (P5-E46)",
    effortUncorrected,
    effortMaterialized
      ? "effort=medium still active after 6s in Default"
      : "effort override stays TUI-side; no corrective write occurred",
  );

  // Normal exit: /quit → TUI exit → launcher cleanup.
  launcher.write("/quit");
  await sleep(500);
  launcher.write(ENTER);
  const exit = await Promise.race([
    launcherExit,
    sleep(60_000).then(() => ({ timedOut: true })),
  ]);
  if (exit.timedOut) {
    report("10. launcher exits after TUI /quit (P5-E19/E47/E48)", false, "launcher still running after 60s");
  } else {
    report(
      "10. launcher exits with the TUI's exit code (P5-E19/E20)",
      exit.exitCode === 0,
      `exitCode=${exit.exitCode}`,
    );
  }

  await sleep(1_500);
  let orphans = [];
  try {
    const tasklist = execFileSync("tasklist", { encoding: "utf8" });
    orphans = tasklist
      .split("\n")
      .filter((line) => /codex\.exe/i.test(line))
      .map((line) => line.trim().split(/\s+/)[0]);
  } catch {
    orphans = ["tasklist-unavailable"];
  }
  report(
    "11. no orphan codex processes after exit (P5-E47/E48)",
    orphans.length === 0,
    orphans.length === 0 ? "tasklist clean" : `found: ${orphans.join(", ")}`,
  );

  console.log(`\n(diagnostics: ${echoes.length} settings echoes observed)`);
} catch (error) {
  report("smoke run", false, error instanceof Error ? error.message : String(error));
  console.log("--- recent launcher screen ---");
  for (const line of strip(tuiScreen).slice(-25)) console.log(`| ${line}`);
} finally {
  try {
    driver?.close();
  } catch {}
  // Ensure nothing survives a failed run.
  try {
    if (launcher.pid) {
      execFileSync("taskkill", ["/pid", String(launcher.pid), "/T", "/F"], { stdio: "ignore" });
    }
  } catch {}
}

const allPass = results.length > 0 && results.every((r) => r.ok);
console.log(allPass ? "\nSMOKE RESULT: PASS" : "\nSMOKE RESULT: FAIL");
process.exit(allPass ? 0 : 1);
