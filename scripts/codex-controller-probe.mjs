#!/usr/bin/env node
/**
 * Real Codex probe for the passive controller (Phase 3, directives §32-33).
 * Uses the BUILT adapter (adapters/codex/dist) against the REAL Codex CLI
 * app-server with TWO clients:
 *
 *     Controller (production ModelController, fully event-driven)
 *         \
 *          dedicated real app-server (via Phase 1 runtime)
 *         /
 *     Test Driver (test-only client; simulates the future TUI)
 *
 * Verified steps:
 *   1. runtime boots the session-dedicated app-server (Phase 1)
 *   2. Controller connects + initializes → LISTENING
 *   3. driver starts a fresh top-level thread; Controller binds it
 *   4. initial thread/resume returns the expected fresh-thread pending
 *      ("no rollout found") — NO manual subscribe call anywhere
 *   5. driver runs a first real turn; the thread's real
 *      thread/status/changed(idle) drives the AUTOMATIC subscription retry
 *   6. Controller becomes subscribed and the collaboration mode becomes
 *      known (resume snapshot and/or settings events)
 *   7. driver switches default → plan → default; Controller observes both
 *   8. passive-subscriber interference check: with the Controller still
 *      subscribed, the driver runs an ordinary turn to NORMAL completion —
 *      the Controller stays listening, emits no disabled event, and (per
 *      the fake-server regression + production boundary scans) sends no
 *      JSON-RPC response frames and never thread/settings/update
 *   9. deterministic cleanup (controller stop incl. best-effort
 *      unsubscribe, driver close, runtime stop)
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

async function runTurn(driverConnection, threadId, seenNotifications, label) {
  await driverConnection.request(
    "turn/start",
    { threadId, input: [{ type: "text", text: "Reply with exactly: OK" }] },
    20_000,
  );
  const before = seenNotifications.length;
  await waitFor(
    () =>
      seenNotifications
        .slice(before)
        .some((m) => m === "turn/completed" || m === "turn/failed"),
    300_000,
    `${label} completion`,
  );
  return seenNotifications.slice(before).includes("turn/completed");
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

  // 3. Test driver connects + starts a fresh top-level thread
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
  const thread = await driver.request("thread/start", {});
  const threadId = thread?.thread?.id ?? null;
  report("3. driver initialized + started fresh top-level thread", threadId !== null, threadId ?? "n/a");

  // 4. Controller binds; the automatic initial resume hits the fresh-thread
  //    pending path — with NO manual orchestration anywhere.
  await waitFor(() => controller.boundThreadId === threadId, 10_000, "thread binding");
  await waitFor(
    () => controllerEvents.some((e) => e.type === "threadSubscriptionPending"),
    15_000,
    "fresh-thread pending",
  );
  report(
    "4. automatic initial resume → expected fresh-thread PENDING (not Disabled)",
    controller.subscription === "pending" && controller.state === "listening",
  );

  // 5. First real turn materializes the rollout; the real idle status
  //    transition drives the automatic retry.
  console.log("  running first real turn (materializes rollout; idle drives retry)…");
  const firstTurnCompleted = await runTurn(driver, threadId, driverNotifications, "first turn");
  await waitFor(
    () => controllerEvents.some((e) => e.type === "threadSubscribed"),
    60_000,
    "automatic subscription convergence",
  );
  report(
    "5. real status/idle → AUTOMATIC subscription convergence",
    controller.subscription === "subscribed",
    `first turn completed=${firstTurnCompleted}`,
  );

  // 6. Collaboration mode becomes known (resume snapshot and/or settings).
  await waitFor(
    () => controllerEvents.some((e) => e.type === "initialModeObserved"),
    60_000,
    "initial mode observation",
  );
  const initialMode = controllerEvents.find((e) => e.type === "initialModeObserved");
  report(
    "6. collaboration mode known without any manual call",
    typeof initialMode?.mode === "string",
    `initial=${initialMode?.mode ?? "unknown"}`,
  );

  // 7. Mode transitions default → plan → default observed.
  const model = thread?.thread?.model ?? "default-model";
  await driver.request("thread/settings/update", {
    threadId,
    collaborationMode: { mode: "plan", settings: { model } },
  });
  await waitFor(
    () => controllerEvents.some((e) => e.type === "modeChanged" && e.to === "plan"),
    15_000,
    "modeChanged(→plan)",
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
  report("7. Controller observed default→plan→default transitions", true);

  // 8. Passive-subscriber interference check: an ordinary turn while the
  //    Controller is subscribed completes normally and the Controller
  //    stays healthy and silent (non-response is wire-verified by the
  //    fake-server regression test + production boundary scans).
  console.log("  running an ordinary turn while the Controller is subscribed…");
  const secondCompleted = await runTurn(driver, threadId, driverNotifications, "subscribed turn");
  const disabledDuring = controllerEvents.some((e) => e.type === "disabled");
  report(
    "8. subscribed Controller does not interfere: ordinary turn completes",
    secondCompleted && controller.state === "listening" && !disabledDuring,
    `turnCompleted=${secondCompleted}, controller=${controller.state}`,
  );

  // 9. Deterministic cleanup (controller stop includes best-effort unsubscribe)
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
