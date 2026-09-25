#!/usr/bin/env node
/**
 * Real Codex integration probe for the Model Controller (Phase 2, directive
 * §30). Uses the BUILT adapter (adapters/codex/dist) against the REAL Codex
 * CLI app-server with TWO clients:
 *
 *     Controller (production ModelController)
 *         \
 *          dedicated real app-server (via Phase 1 runtime)
 *         /
 *     Test Driver (test-only client; simulates the future TUI)
 *
 * Verified steps:
 *   1. runtime boots the session-dedicated app-server (Phase 1)
 *   2. Controller connects + initializes (experimentalApi) → LISTENING
 *   3. Driver connects + initializes
 *   4. Driver creates a real top-level thread
 *   5. Controller receives thread/started and binds it
 *   6. Driver runs one real turn — on codex-cli 0.156.1 a fresh thread
 *      cannot be attached via thread/resume until its rollout exists, and
 *      the rollout appears with the thread's first activity
 *   7. Controller subscribes to the thread's notification fan-out
 *   8. Driver switches collaboration mode default → plan → default; the
 *      Controller observes InitialModeObserved(plan) + ModeChanged(plan→
 *      default) — exactly the frozen Phase 2 observation boundary
 *   9. deterministic cleanup (controller stop, driver close, runtime stop)
 *
 * The driver exists ONLY in this script — never in production code.
 * Usage: node scripts/codex-controller-probe.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeEntry = path.join(repoRoot, "adapters", "codex", "dist", "index.js");

if (!existsSync(runtimeEntry)) {
  console.error("BUILT ADAPTER MISSING — run `npm run build -w @switchboard/codex` first");
  process.exit(2);
}

const {
  AppServerRpcConnection,
  CodexSessionRuntime,
  ModelController,
  createLoopbackEndpoint,
} = await import(pathToFileURL(runtimeEntry).href);

const results = [];
function report(step, ok, detail = "") {
  results.push({ ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function resolveCodexLaunch() {
  if (process.platform !== "win32") {
    return { command: "codex", args: [] };
  }
  return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "codex"] };
}

const versionProbe =
  process.platform === "win32"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "codex", "--version"], {
        encoding: "utf8",
      })
    : spawnSync("codex", ["--version"], { encoding: "utf8" });
const version = (versionProbe.stdout ?? "").trim();
if (!version) {
  console.log("SKIP  real Codex controller probe — no usable Codex CLI on PATH");
  process.exit(0);
}
console.log(`Codex CLI: ${version}`);

const { command, args } = resolveCodexLaunch();
const runtime = new CodexSessionRuntime({
  command,
  args: [...args, "app-server", "--listen", "ws://127.0.0.1:0"],
});

const controller = new ModelController({ clientVersion: "0.1.0" });
const controllerEvents = [];
controller.onEvent((event) => {
  controllerEvents.push(event);
  console.log(`  [controller] ${JSON.stringify(event)}`);
});

const driverNotifications = [];
let driver = null;

async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return true;
    }
    await sleep(1_000);
  }
  throw new Error(`${label}: not satisfied within ${timeoutMs}ms`);
}

try {
  // 1. Phase 1 runtime → READY endpoint
  const endpoint = await runtime.start();
  report("1. app-server READY on OS-assigned endpoint", true, endpoint.wsUrl);

  // 2. Controller connects + initializes
  const parsed = createLoopbackEndpoint(endpoint.host, endpoint.port);
  await controller.connect(parsed);
  report(
    "2. Controller initialized (experimentalApi=true) → LISTENING",
    controller.state === "listening",
  );

  // 3. Test driver connects + initializes
  driver = new AppServerRpcConnection(endpoint.wsUrl, {
    onNotification: (notification) => {
      driverNotifications.push(notification.method);
    },
  });
  await driver.open();
  await driver.request("initialize", {
    clientInfo: { name: "phase-model-probe-driver", version: "0.0.0" },
    capabilities: { experimentalApi: true },
  });
  driver.notify("initialized");
  report("3. Test driver initialized", true);

  // 4. Driver creates a real top-level thread
  const thread = await driver.request("thread/start", {});
  const threadId = thread?.thread?.id ?? null;
  report("4. driver created a real top-level thread", threadId !== null, threadId ?? "n/a");

  // 5. Controller receives thread/started and binds it
  await waitFor(() => controller.boundThreadId === threadId, 10_000, "thread binding");
  report("5. Controller observed thread/started and bound the top-level thread", true);

  // 6. One real turn — codex 0.156.1 needs the thread rollout to exist
  //    before a second client can attach (thread/resume).
  console.log("  starting a real turn (persisting the thread rollout)…");
  await driver.request(
    "turn/start",
    { threadId, input: [{ type: "text", text: "Reply with exactly: OK" }] },
    20_000,
  );
  await waitFor(
    () =>
      driverNotifications.includes("turn/completed") ||
      driverNotifications.includes("turn/failed"),
    240_000,
    "turn completion",
  );
  report(
    "6. real turn completed (thread rollout persisted)",
    driverNotifications.includes("turn/completed"),
  );

  // 7. Controller subscribes to the thread's notification fan-out
  const subscribed = await controller.subscribeToCurrentThread();
  report("7. Controller subscribed via thread/resume", subscribed);

  // 8. Mode observation: default → plan → default (driver-side mode switches)
  const model = thread?.thread?.model ?? "default-model";
  await driver.request("thread/settings/update", {
    threadId,
    collaborationMode: { mode: "plan", settings: { model } },
  });
  await waitFor(
    () => controllerEvents.some((e) => e.type === "initialModeObserved" && e.mode === "plan"),
    15_000,
    "initialModeObserved(plan)",
  );

  await driver.request("thread/settings/update", {
    threadId,
    collaborationMode: { mode: "default", settings: { model } },
  });
  await waitFor(
    () =>
      controllerEvents.some(
        (e) => e.type === "modeChanged" && e.from === "plan" && e.to === "default",
      ),
    15_000,
    "modeChanged(plan→default)",
  );
  report("8. Controller observed InitialModeObserved(plan) + ModeChanged(plan→default)", true);

  // 9. Deterministic cleanup
  await controller.stop();
  await driver.close();
  await runtime.shutdown();
  report(
    "9. deterministic cleanup",
    controller.state === "stopped" && runtime.state === "stopped",
    `controller=${controller.state}, runtime=${runtime.state}`,
  );
} catch (error) {
  report("probe run", false, error instanceof Error ? error.message : String(error));
  try {
    await controller.stop();
  } catch {}
  try {
    await driver?.close();
  } catch {}
  try {
    if (runtime.state === "starting" || runtime.state === "ready") {
      await runtime.shutdown();
    }
  } catch {}
}

const allPass = results.length > 0 && results.every((r) => r.ok);
console.log(allPass ? "\nPROBE RESULT: PASS" : "\nPROBE RESULT: FAIL");
process.exit(allPass ? 0 : 1);
