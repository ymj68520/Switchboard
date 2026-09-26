#!/usr/bin/env node
/**
 * Real Codex probe for phase-triggered model application (Phase 4,
 * directives §37-40). Uses the BUILT adapter with TWO clients:
 *
 *     Controller + PhaseModelSwitcher (production)
 *         \
 *          dedicated real app-server (via Phase 1 runtime)
 *         /
 *     Test Driver (test-only; simulates the future TUI and OBSERVES the
 *     authoritative thread settings echoes)
 *
 * Flow:
 *   1. runtime READY; 2. Controller LISTENING; 3. switcher started with two
 *   valid model IDs (env override → model/list discovery → same-model
 *   fallback); 4. driver starts a fresh thread; 5. first real turn
 *   materializes the rollout; 6. subscription converges;
 *   7. InitialModeObserved(Default) → executionModel is APPLIED and the
 *   server echo reports threadSettings.model == executionModel with mode
 *   still Default; 8. driver enters Plan → planningModel applied, mode
 *   stays Plan; 9. driver runs a same-mode manual /model → the switcher
 *   does NOT override it; 10. driver leaves Plan → executionModel
 *   reapplied; 11. reasoning effort is unchanged across every echo;
 *   12. deterministic cleanup.
 *
 * Model-ID discovery may call model/list — as a TEST helper only; the
 * production controller/switcher never does (statically pinned).
 * Usage: node scripts/codex-model-switch-probe.mjs
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
  PhaseModelSwitcher,
  createLoopbackEndpoint,
} = await import(pathToFileURL(runtimeEntry).href);

const results = [];
let distinctModelsExercised = true;
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
async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return true;
    }
    await sleep(500);
  }
  throw new Error(`${label}: not satisfied within ${timeoutMs}ms`);
}

const versionProbe =
  process.platform === "win32"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "codex", "--version"], {
        encoding: "utf8",
      })
    : spawnSync("codex", ["--version"], { encoding: "utf8" });
const version = (versionProbe.stdout ?? "").trim();
if (!version) {
  console.log("SKIP  real Codex model-application probe — no usable Codex CLI on PATH");
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
const driverEchoes = [];
let driver = null;

async function runTurn(driverConnection, threadId, label) {
  const before = driverNotifications.length;
  await driverConnection.request(
    "turn/start",
    { threadId, input: [{ type: "text", text: "Reply with exactly: OK" }] },
    20_000,
  );
  await waitFor(
    () =>
      driverNotifications
        .slice(before)
        .some((m) => m === "turn/completed" || m === "turn/failed"),
    300_000,
    `${label} completion`,
  );
}

try {
  // 1-2. runtime + controller
  const endpoint = await runtime.start();
  report("1. app-server READY on OS-assigned endpoint", true, endpoint.wsUrl);
  const parsed = createLoopbackEndpoint(endpoint.host, endpoint.port);
  await controller.connect(parsed);
  report("2. Controller initialized → LISTENING", controller.state === "listening");

  // 3. driver + model selection (env → model/list → same-model fallback)
  driver = new AppServerRpcConnection(endpoint.wsUrl, {
    onNotification: (notification) => {
      driverNotifications.push(notification.method);
      if (notification.method === "thread/settings/updated") {
        const ts = notification.params?.threadSettings ?? {};
        driverEchoes.push({
          model: ts.model ?? null,
          mode: ts.collaborationMode?.mode ?? null,
          effort: ts.effort ?? null,
        });
        console.log(`  [driver echo] model=${JSON.stringify(ts.model)} mode=${JSON.stringify(ts.collaborationMode?.mode)} effort=${JSON.stringify(ts.effort)}`);
      }
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
  const currentModel = thread?.thread?.model ?? null;
  report("3. driver initialized + fresh top-level thread", threadId !== null, threadId ?? "n/a");

  let planningModel = process.env.CODEX_TEST_PLANNING_MODEL ?? null;
  let executionModel = process.env.CODEX_TEST_EXECUTION_MODEL ?? null;
  if (!planningModel || !executionModel) {
    try {
      const listing = await driver.request("model/list", {}, 15_000);
      const ids = (listing?.models ?? listing?.data ?? [])
        .map((entry) => entry?.id ?? entry?.model ?? entry?.slug)
        .filter((id) => typeof id === "string" && id.length > 0);
      if (!executionModel && ids.length > 0) {
        executionModel = ids[0];
      }
      if (!planningModel) {
        planningModel = ids.find((id) => id !== executionModel) ?? executionModel ?? null;
      }
    } catch {
      // model/list unavailable → fall through to same-model fallback below.
    }
  }
  if (!planningModel || !executionModel) {
    planningModel = currentModel;
    executionModel = currentModel;
  }
  if (planningModel === executionModel) {
    distinctModelsExercised = false;
    console.log("  NOTE: only one usable model ID — running SAME-MODEL smoke");
    console.log("        (distinct-model transition not fully exercised)");
  }
  console.log(`  models: planning=${planningModel} execution=${executionModel}`);
  const switcher = new PhaseModelSwitcher(controller, {
    planningModel: planningModel,
    executionModel: executionModel,
  });
  const switcherEvents = [];
  switcher.onEvent((event) => {
    switcherEvents.push(event);
    console.log(`  [switcher] ${JSON.stringify(event)}`);
  });
  switcher.start();
  report("4. PhaseModelSwitcher active with configured models", switcher.state === "active");

  // 5. first real turn → automatic subscription convergence → initial write
  console.log("  running first real turn (materializes rollout)…");
  await runTurn(driver, threadId, "first turn");
  await waitFor(
    () => controllerEvents.some((e) => e.type === "threadSubscribed"),
    60_000,
    "subscription convergence",
  );
  await waitFor(
    () => switcherEvents.some((e) => e.type === "modelApplied"),
    60_000,
    "initial model application",
  );
  report(
    "5. InitialModeObserved(Default) → executionModel applied",
    true,
    `model=${executionModel}`,
  );

  // 6. server-side verification. With DISTINCT models the update is a real
  // change → the authoritative echo must report the new model. If the thread
  // already STARTED at executionModel (observed on 0.156.1 once a local API
  // key login exists — the server derives the default from the account), the
  // initial write is a NO-OP (change-dedup emits no echo) and acceptance is
  // proven by modelApplied + the absence of failure.
  const initialEffort = thread?.thread?.reasoningEffort ?? null;
  const initialModelIsTarget = (thread?.thread?.model ?? null) === executionModel;
  if (distinctModelsExercised && !initialModelIsTarget) {
    await waitFor(
      () =>
        driverEchoes.some(
          (echo) => echo.model === executionModel && echo.mode === "default",
        ),
      30_000,
      "execution-model echo",
    );
    const execEcho = [...driverEchoes]
      .reverse()
      .find((echo) => echo.model === executionModel && echo.mode === "default");
    report(
      "6. Codex echo: model == executionModel, mode stays Default, effort preserved",
      execEcho.effort === initialEffort,
      `effort ${JSON.stringify(initialEffort)} -> ${JSON.stringify(execEcho.effort)}`,
    );
  } else {
    const failed = switcherEvents.some((e) => e.type === "automationDisabled");
    if (initialModelIsTarget) {
      console.log(
        "  NOTE: thread already starts at executionModel — initial write is a no-op",
      );
      console.log("        (change-dedup: no echo expected for the initial application)");
    } else {
      console.log("  NOTE: only one usable model ID — running SAME-MODEL smoke");
    }
    report(
      "6. model update accepted (no-op write: no echo expected)",
      !failed && controller.observedMode === "default",
      `mode=${controller.observedMode ?? "unknown"} initialModel=${JSON.stringify(initialModelIsTarget ? executionModel : currentModel)}`,
    );
  }

  // 7. Default → Plan → planningModel applied, mode stays Plan. (NOTE: the
  // DRIVER's mode change itself may reset effort — Codex-native per-mode
  // settings, out of the switcher's scope per Architecture SPEC §17. The
  // invariant measured here is that OUR model-only write preserves effort.)
  await driver.request("thread/settings/update", {
    threadId,
    collaborationMode: { mode: "plan", settings: { model: executionModel } },
  });
  await waitFor(
    () => driverEchoes.some((echo) => echo.mode === "plan"),
    30_000,
    "plan-mode echo",
  );
  const effortBeforePlanWrite = [...driverEchoes]
    .reverse()
    .find((echo) => echo.mode === "plan").effort;
  await waitFor(
    () => driverEchoes.some((echo) => echo.model === planningModel && echo.mode === "plan"),
    30_000,
    "planning-model echo",
  );
  const planEcho = [...driverEchoes]
    .reverse()
    .find((echo) => echo.model === planningModel && echo.mode === "plan");
  report(
    "7. Default → Plan: planningModel applied, mode stays Plan",
    planEcho.effort === effortBeforePlanWrite,
    `effort ${JSON.stringify(effortBeforePlanWrite)} -> ${JSON.stringify(planEcho.effort)}`,
  );

  // 8. same-mode manual /model → the switcher must NOT override it.
  const manualModel = "phase4-manual-model";
  await driver.request("thread/settings/update", { threadId, model: manualModel });
  await waitFor(
    () => driverEchoes.some((echo) => echo.model === manualModel && echo.mode === "plan"),
    30_000,
    "manual-model echo",
  );
  const echoesAtManual = driverEchoes.length;
  await sleep(4_000);
  const overridesAfterManual = driverEchoes
    .slice(echoesAtManual)
    .some((echo) => echo.model !== manualModel);
  report(
    "8. same-mode manual /model survives (switcher does not override)",
    !overridesAfterManual,
  );

  // 9. Plan → Default → executionModel reapplied (effort preserved by OUR
  // write across the manual-model interval).
  await driver.request("thread/settings/update", {
    threadId,
    collaborationMode: { mode: "default", settings: { model: manualModel } },
  });
  await waitFor(
    () => driverEchoes.some((echo) => echo.mode === "default"),
    30_000,
    "default-mode echo",
  );
  const effortBeforeDefaultWrite = [...driverEchoes]
    .reverse()
    .find((echo) => echo.mode === "default").effort;
  await waitFor(
    () => driverEchoes.some((echo) => echo.model === executionModel && echo.mode === "default"),
    30_000,
    "re-applied execution-model echo",
  );
  const defaultEcho = [...driverEchoes]
    .reverse()
    .find((echo) => echo.model === executionModel && echo.mode === "default");
  report(
    "9. Plan → Default: executionModel reapplied",
    defaultEcho.effort === effortBeforeDefaultWrite,
    `effort ${JSON.stringify(effortBeforeDefaultWrite)} -> ${JSON.stringify(defaultEcho.effort)}`,
  );

  // 10. Effort changes, when they occur, must come from the DRIVER's own
  // mode switches (Codex-native per-mode settings), never from a switcher
  // write — which the per-checkpoint comparisons in 6/7/9 pin down.
  const effortSet = [...new Set(driverEchoes.map((echo) => JSON.stringify(echo.effort)))];
  const ourWritesPreservedEffort =
    results.filter((r) => r.ok).length === results.length; // 6/7/9 checkpoints
  report(
    "10. no effort mutation attributable to model-only updates",
    ourWritesPreservedEffort,
    `effort values seen across all echoes: ${effortSet.join(", ") || "(none)"}`,
  );

  // 11. deterministic cleanup
  await switcher.stop();
  await controller.stop();
  await driver.close();
  await runtime.shutdown();
  report(
    "11. deterministic cleanup",
    switcher.state === "stopped" && controller.state === "stopped" && runtime.state === "stopped",
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
if (!distinctModelsExercised) {
  console.log("NOTE: distinct-model transition not fully exercised (same-model smoke).");
}
process.exit(allPass ? 0 : 1);
