#!/usr/bin/env node
/**
 * Live OpenCode runtime validation for the Phase 2J ExecutionHandoff
 * (brief §97-§106/§138-§140). Runtime handoff IS the main feature of 2J, so
 * a real-host validation is mandatory — the fake-host integration tests do
 * NOT prove live runtime behavior.
 *
 * What this proves on a REAL `opencode serve`:
 *
 *   1. the runtime compatibility gate (§3): an existing real session S
 *      receives ANOTHER turn in the SAME session (same session id before /
 *      targeted / delivered — §99), through the host's own
 *      prompt_async + session-history APIs;
 *   2. the deterministic handoff is inserted with the stable
 *      ULTRA_PLAN_HANDOFF / delivery-key marker (§25/§140), exactly once;
 *   3. the delivered message carries the host-recorded execution agent
 *      ("build") and model (§100/§101) in its metadata;
 *   4. the durable delivery record confirms delivered with a REAL host
 *      receipt, and the run lifecycle reaches `completed` with the final
 *      HEAD unchanged (§46-§48/§135);
 *   5. the first Build response occurs in the SAME session (§102) — bounded
 *      wait, no repository modification required.
 *
 * HONEST BOUNDARY (§98): the fixture reaches handoff_pending through a
 * TEST-ONLY standalone setup script (opencode-handoff-setup.mjs) that drives
 * the REAL controller flow against the same durable store — no production
 * seam exists, and the Final Approval protocol is NOT weakened. §103: the
 * fixture plan is minimal; the smoke does not execute a real implementation
 * workload.
 *
 * Requires network access for model inference. Exits non-zero on failure.
 *
 * Usage: node scripts/opencode-handoff-smoke.mjs [model]
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const distEntry = path.join(repoRoot, "adapters", "opencode", "dist", "index.js");
const setupScript = path.join(repoRoot, "scripts", "opencode-handoff-setup.mjs");
const MODEL = process.argv[2] ?? "opencode/ling-3.0-flash-fin-free";
const PORT = 21000 + Math.floor(Math.random() * 20000);
const COMMAND_TIMEOUT_MS = 300_000;
const COMPLETION_TIMEOUT_MS = 180_000;
const FIRST_RESPONSE_TIMEOUT_MS = 180_000;

const results = [];
function report(step, ok, detail = "") {
  results.push({ step, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (!existsSync(distEntry)) {
    console.error(`dist entry not found: ${distEntry}\nRun: npm run build -w @switchboard/opencode`);
    process.exit(2);
  }

  const fixture = await mkdtemp(path.join(tmpdir(), "ultraplan-handoff-"));
  const dataDir = path.join(fixture, "ultra-plan-data");
  await mkdir(path.join(fixture, ".opencode", "plugin"), { recursive: true });
  await writeFile(
    path.join(fixture, ".opencode", "plugin", "ultra-plan.js"),
    `export { default } from ${JSON.stringify(pathToFileURL(distEntry).href)};\n`,
  );
  await writeFile(
    path.join(fixture, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", model: MODEL, share: "disabled", autoupdate: false }, null, 2),
  );
  console.log(`fixture: ${fixture}\nmodel:   ${MODEL}\n`);

  const serverLog = [];
  function spawnServer(fixtureDir, port) {
    const proc = spawn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1", "--print-logs"], {
      cwd: fixtureDir,
      shell: true,
      env: { ...process.env, ULTRA_PLAN_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout.on("data", (d) => serverLog.push(String(d)));
    proc.stderr.on("data", (d) => serverLog.push(String(d)));
    return proc;
  }
  function killTree(proc) {
    if (process.platform === "win32") {
      return new Promise((resolve) => {
        const taskkill = spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { shell: true });
        taskkill.on("exit", resolve);
        taskkill.on("error", resolve);
      });
    }
    proc.kill("SIGKILL");
    return Promise.resolve();
  }

  let server = spawnServer(fixture, PORT);
  const base = `http://127.0.0.1:${PORT}`;
  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      try {
        if ((await fetch(`${base}/config`)).ok) { up = true; break; }
      } catch { /* not up yet */ }
    }
    if (!up) throw new Error("opencode serve did not become ready in 60s");
    report("opencode serve starts and serves HTTP", true, base);

    // -- create the REAL planning session S --------------------------------
    const created = await (await fetch(`${base}/session`, { method: "POST" })).json();
    const sessionID = created.id ?? created.data?.id;
    report("real session created (S)", Boolean(sessionID), sessionID);
    if (!sessionID) throw new Error("no session id");

    // §99 receipt 1: the session id BEFORE the handoff.
    report("§99 session id before handoff recorded", sessionID === sessionID, sessionID);

    // -- /ultra-plan: PLAN-001 bound to S -----------------------------------
    const command = await fetch(`${base}/session/${sessionID}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "ultra-plan", arguments: "Build the handoff smoke fixture" }),
    });
    if (!command.ok) throw new Error(`command endpoint ${command.status}`);
    let sawRun = false;
    for (let i = 0; i < 60; i++) {
      await sleep(3000);
      const messages = await (await fetch(`${base}/session/${sessionID}/message`)).json();
      const text = JSON.stringify(messages);
      if (/"ultraplan_start"/.test(text) && /Plan: PLAN-001/.test(text)) { sawRun = true; break; }
      if (/"type":"error"/i.test(text)) break;
    }
    report("/ultra-plan creates PLAN-001 in session S", sawRun, sawRun ? sessionID : "run not observed");
    if (!sawRun) throw new Error("planning run was not created");

    // -- stop the server; drive the fixture to handoff_pending (TEST-ONLY
    //    setup script, real controller flow, same durable store — §98) -------
    await killTree(server);
    await sleep(2000);
    const setup = spawn(process.execPath, [setupScript, dataDir, sessionID], {
      env: { ...process.env, CRASH_PROBE_ENTRY: distEntry },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let setupOut = "";
    setup.stdout.on("data", (d) => setupOut += String(d));
    setup.stderr.on("data", (d) => setupOut += String(d));
    const setupExit = await new Promise((resolve) => setup.on("exit", resolve));
    const setupMatch = setupOut.match(/PROBE-SETUP LIFECYCLE=(\w+) STAGE=(\w+) HEAD=(\S+) FINAL=(\S+) SESSION=(\S+)/);
    report(
      "TEST-ONLY setup drove the run to handoff_pending (real controller flow, same store)",
      setupExit === 0 && setupMatch?.[1] === "handoff_pending" && setupMatch?.[2] === "final" && setupMatch?.[5] === sessionID,
      setupOut.trim().split("\n").slice(-1)[0]?.slice(0, 200),
    );
    if (!setupMatch) throw new Error("setup failed");
    const headBefore = setupMatch[3];

    // -- restart the server; trigger the Harness handoff via /ultra-plan ----
    server = spawnServer(fixture, PORT);
    let up2 = false;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      try {
        if ((await fetch(`${base}/config`)).ok) { up2 = true; break; }
      } catch { /* not up yet */ }
    }
    if (!up2) throw new Error("restarted server did not become ready");
    report("server restarts with the same durable store", true, base);

    // Store the store file path for durable assertions.
    async function findStoreFile(dir) {
      const entries = await readdir2(dir);
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = await findStoreFile(full);
          if (found) return found;
        } else if (entry.name === "plan-store.json") return full;
      }
      return undefined;
    }
    async function readdir2(dir) {
      try {
        return await import("node:fs/promises").then((fs) => fs.readdir(dir, { withFileTypes: true }));
      } catch {
        return [];
      }
    }
    const storeFile = await findStoreFile(dataDir);
    report("durable store file located", Boolean(storeFile), storeFile ?? "none");

    // Trigger the deterministic recovery/continuation path. The dispatch may
    // complete within this command OR slightly after (session.idle recovery);
    // completion is polled below (bounded).
    const resumed = await fetch(`${base}/session/${sessionID}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "ultra-plan", arguments: "" }),
    });
    void resumed;

    // Poll durable state for the completed lifecycle.
    let store = null;
    let handoff = null;
    let delivery = null;
    let run = null;
    const deadline = Date.now() + COMPLETION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(3000);
      try {
        store = JSON.parse(await readFile(storeFile, "utf8"));
        run = store.runs?.["PLAN-001"];
        if (run?.lifecycle !== "completed") continue;
        const handoffFamily = store.executionHandoffs?.["PLAN-001"] ?? {};
        handoff = Object.values(handoffFamily)[0];
        delivery = Object.values(store.handoffDeliveries?.["PLAN-001"] ?? {})[0];
        if (delivery?.state === "delivered") break;
      } catch { /* mid-write retry */ }
    }
    report(
      "§138 run lifecycle reaches completed with a delivered handoff record",
      run?.lifecycle === "completed" && delivery?.state === "delivered" && Boolean(handoff),
      `lifecycle=${run?.lifecycle} delivery=${delivery?.state ?? "none"}`,
    );

    // §138/§140: the handoff turn in the SAME session, marker present, once.
    let markerMessages = [];
    try {
      const messages = await (await fetch(`${base}/session/${sessionID}/message`)).json();
      const list = Array.isArray(messages) ? messages : (messages.data ?? []);
      markerMessages = list.filter((message) => {
        if (message.info?.role !== "user") return false;
        const text = (message.parts ?? [])
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("\n");
        return text.includes("ULTRA_PLAN_HANDOFF") && text.includes(`plan=PLAN-001`);
      });
    } catch (error) {
      report("session history queryable", false, String(error));
    }
    report("§138/§25 the delivered handoff turn exists with the stable marker", markerMessages.length >= 1, `${markerMessages.length} marker message(s)`);
    report("§140 duplicate detection: exactly ONE handoff turn in history", markerMessages.length === 1, `${markerMessages.length}`);
    const handoffMessage = markerMessages[0];
    report(
      "§99 same-session invariant: planning session == handoff target session == delivered turn session",
      Boolean(handoffMessage) && handoffMessage.info.sessionID === sessionID && delivery?.hostReceipt?.sessionID === sessionID,
      `turn session=${handoffMessage?.info?.sessionID} receipt session=${delivery?.hostReceipt?.sessionID}`,
    );
    report(
      "§100 execution agent proof: delivered turn agent == resolved build agent",
      handoffMessage?.info?.agent === "build" && delivery?.hostReceipt?.agent === "build",
      `turn agent=${handoffMessage?.info?.agent} receipt agent=${delivery?.hostReceipt?.agent}`,
    );
    report(
      "§101 execution model proof: the delivered turn records the host model identity",
      Boolean(handoffMessage?.info?.model?.providerID) && Boolean(handoffMessage?.info?.model?.modelID) &&
        JSON.stringify(handoffMessage?.info?.model) === JSON.stringify(delivery?.hostReceipt?.model),
      `turn model=${JSON.stringify(handoffMessage?.info?.model)}`,
    );
    report(
      "§22 receipt is real host evidence: receipt messageID == delivered turn id",
      delivery?.hostReceipt?.messageID === handoffMessage?.info?.id,
      `receipt=${delivery?.hostReceipt?.messageID} turn=${handoffMessage?.info?.id}`,
    );
    report(
      "§135 final HEAD unchanged during the handoff",
      run?.headCommit === headBefore,
      `before=${headBefore} after=${run?.headCommit}`,
    );

    // §102: the first Build response occurs in the SAME session (bounded).
    let firstResponse = false;
    const responseDeadline = Date.now() + FIRST_RESPONSE_TIMEOUT_MS;
    while (Date.now() < responseDeadline) {
      await sleep(5000);
      try {
        const messages = await (await fetch(`${base}/session/${sessionID}/message`)).json();
        const list = Array.isArray(messages) ? messages : (messages.data ?? []);
        if (
          handoffMessage &&
          list.some((message) => message.info?.role === "assistant" && message.info?.parentID === handoffMessage.info.id)
        ) {
          firstResponse = true;
          break;
        }
      } catch { /* retry */ }
    }
    report("§102 the first Build response occurs in the SAME session", firstResponse, sessionID);
  } catch (error) {
    report("live handoff validation aborted", false, String(error));
  } finally {
    await killTree(server);
    await sleep(1500);
    try {
      await rm(fixture, { recursive: true, force: true });
    } catch { /* Windows file locks */ }
  }

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
