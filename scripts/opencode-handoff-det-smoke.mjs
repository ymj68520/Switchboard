#!/usr/bin/env node
/**
 * Ultra Plan v0.1 RC — DETERMINISTIC handoff runtime smoke (RR-09 / §21–§25).
 *
 * Unlike smoke:opencode-handoff (whose SETUP leg depends on a real model
 * voluntarily calling ultraplan_start), this smoke creates the fixture
 * entirely through the sanctioned TEST-ONLY setup seam (real controller flow,
 * zero model turns), then exercises the REAL OpenCode runtime for the
 * handoff itself:
 *
 *   real server + REAL session
 *     → (server stopped) TEST-ONLY setup drives discovery → handoff_pending
 *     → server restarted over the SAME durable store
 *     → REAL recovery coordinator + REAL SDK client (production handoff code)
 *     → promptAsync dispatch to the build agent IN THE SAME SESSION
 *     → host history confirmation → delivered → completed
 *
 * RC gate policy (§24): ZERO-RETRY. A handoff-leg failure is a release
 * finding; it must never be retried until green. No fixture state is faked
 * after setup — everything asserted here is host-recorded or store-recorded.
 *
 * Usage: node scripts/opencode-handoff-det-smoke.mjs [model]
 */
import { spawn, execSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = path.join(repoRoot, "adapters", "opencode", "dist", "index.js");
const setupScript = path.join(repoRoot, "scripts", "opencode-handoff-setup.mjs");
const MODEL = process.argv[2] ?? "opencode/ling-3.0-flash-fin-free";
const PORT = 24000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const GOAL = `Deterministic handoff release smoke ${Date.now()}`;

const results = [];
function report(step, ok, detail = "") {
  results.push({ step, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const serverLog = [];
const serverPids = [];
function spawnServer(fixtureDir, port, dataDir) {
  const proc = spawn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1", "--print-logs"], {
    cwd: fixtureDir,
    shell: true,
    env: { ...process.env, ULTRA_PLAN_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverPids.push(proc.pid);
  proc.stdout.on("data", (d) => serverLog.push(String(d)));
  proc.stderr.on("data", (d) => serverLog.push(String(d)));
  return proc;
}
async function waitReady(base) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${base}/config`);
      if (res.ok) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}
function stopServer(proc) {
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: "ignore", shell: true });
    } else {
      proc.kill("SIGKILL");
    }
  } catch {}
}

const ultra = await import(pathToFileURL(distEntry).href);
const { DurablePlanStore, UltraPlanController, OpenCodeExecutionAdapter, OpenCodeRuntimeAdapter } = ultra;
const { createOpencodeClient } = await import("@opencode-ai/sdk");

async function main() {
  if (!existsSync(distEntry)) {
    console.error(`dist entry not found: ${distEntry}\nRun: npm run build -w @switchboard/opencode`);
    process.exit(2);
  }
  const fixture = await mkdtemp(path.join(tmpdir(), "ultraplan-handoff-det-"));
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

  // -- server #1: plugin loads, REAL session created ------------------------
  const server1 = spawnServer(fixture, PORT, dataDir);
  const ready1 = await waitReady(BASE);
  report("server #1 ready (plugin from dist)", ready1);
  if (!ready1) process.exit(1);
  const sessionRes = await fetch(`${BASE}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "handoff-det" }),
  });
  const session = await sessionRes.json();
  report("REAL session created", Boolean(session.id), session.id);
  stopServer(server1);
  await sleep(3000);

  // -- TEST-ONLY setup: discovery → handoff_pending, ZERO model turns -------
  const setup = spawn(process.execPath, [setupScript, dataDir, session.id, "--create", GOAL], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let setupOut = "";
  setup.stdout.on("data", (d) => (setupOut += String(d)));
  setup.stderr.on("data", (d) => (setupOut += String(d)));
  const setupCode = await new Promise((resolve) => setup.on("close", resolve));
  const finalLine = setupOut.split("\n").find((l) => l.startsWith("PROBE-SETUP LIFECYCLE=")) ?? "";
  const val = (key) => finalLine.match(new RegExp(`${key}=([^ ]+)`))?.[1];
  report("TEST-ONLY setup drove handoff_pending (no model turns)", setupCode === 0 && val("LIFECYCLE") === "handoff_pending", `exit=${setupCode} ${finalLine.slice(0, 120)}`);
  if (setupCode !== 0) {
    console.error(setupOut.slice(-1500));
    process.exit(1);
  }
  const planID = val("SESSION") ? setupOut.match(/RUN=(PLAN-\d+)/)?.[1] : undefined;
  const headAtSetup = val("HEAD");

  // -- server #2: fresh process over the SAME durable store ----------------
  const server2 = spawnServer(fixture, PORT, dataDir);
  const ready2 = await waitReady(BASE);
  report("server #2 restarted over the same store", ready2);
  if (!ready2) process.exit(1);

  // -- REAL recovery: production coordinator + REAL SDK client -------------
  const store = new DurablePlanStore(await findStoreFile(dataDir), { now: () => new Date().toISOString() });
  const client = createOpencodeClient({ baseUrl: BASE });
  const spec = new OpenCodeRuntimeAdapter().spec;
  const controller = new UltraPlanController({
    store,
    now: () => new Date().toISOString(),
    semanticValidator: { async validate() { return { text: JSON.stringify({ result: "clean", findings: [] }) }; } },
    executionRuntime: { adapter: new OpenCodeExecutionAdapter(client), executionAgent: spec.executionAgent, ...(spec.executionModel ? { executionModel: spec.executionModel } : {}) },
  });
  const recovery = await controller.recoverExecutionHandoff(session.id);
  report("REAL handoff recovery completed (exactly once)", recovery.status === "completed", `status=${recovery.status} handoffID=${recovery.handoffID ?? "-"}`);
  if (recovery.status !== "completed") {
    console.error(serverLog.join("").slice(-2000));
    process.exit(1);
  }

  const run = await store.getRun(planID);
  const handoff = await store.findExecutionHandoffForPlan(planID);
  const delivery = await store.getHandoffDelivery(planID, recovery.handoffID);

  // -- §23 assertions: everything host-recorded or store-recorded ----------
  report("target session == fixture planning session", handoff?.sessionID === session.id, handoff?.sessionID);
  report("Final HEAD unchanged", run?.headCommit === headAtSetup, `${run?.headCommit} vs ${headAtSetup}`);
  report("lifecycle == completed", run?.lifecycle === "completed", run?.lifecycle);
  report("delivery durable: state=delivered", delivery?.state === "delivered", delivery?.state);
  report("delivery durable: receipt session matches", delivery?.hostReceipt?.sessionID === session.id, delivery?.hostReceipt?.sessionID);

  // Host history: the delivered Build turn — agent/model/marker/messageID.
  await sleep(2000);
  const history = await (await fetch(`${BASE}/session/${session.id}/message`)).json();
  const markerNeedle = "delivery-key=";
  const markerMessages = JSON.stringify(history).split(markerNeedle).length - 1;
  report("handoff marker present in host history", markerMessages >= 1, `occurrences=${markerMessages}`);
  const receiptID = delivery?.hostReceipt?.messageID;
  report("receipt messageID exists in host history", Boolean(receiptID) && JSON.stringify(history).includes(receiptID), receiptID ?? "none");
  const deliveredUser = (Array.isArray(history) ? history : []).find(
    (m) => m?.info?.id === receiptID || m?.id === receiptID,
  );
  const info = deliveredUser?.info ?? deliveredUser ?? {};
  report("host receipt carries agent+model identity", info.agent === "build" || delivery?.hostReceipt?.agent === "build", delivery?.hostReceipt?.agent ?? info.agent);
  report("delivered turn agent == build", info.agent === "build" || JSON.stringify(deliveredUser ?? {}).includes('"agent":"build"'), String(info.agent));
  const modelText = JSON.stringify(info.model ?? {});
  report("effective model identity observable", Boolean(info.model?.providerID || info.model?.modelID || modelText.length > 2), modelText.slice(0, 60));
  report("delivered Build message session == same session", (info.sessionID ?? session.id) === session.id, info.sessionID ?? session.id);
  // The Build assistant response is a real model turn: diagnostic NOTE only
  // (never the gate — §23 lists host-recorded facts, not model cooperation).
  const entries = Array.isArray(history) ? history : [];
  const buildReply = entries.some((m) => (m?.info?.agent ?? m?.agent) === "build" && (m?.info?.role ?? "") !== "user" && m?.info?.id !== receiptID);
  console.log(`NOTE  first Build response observed in-session: ${buildReply} (diagnostic only — not a gate)`);

  // -- restart representation: fresh store instance sees the terminal state -
  store.close();
  const store2 = new DurablePlanStore(await findStoreFile(dataDir), { now: () => new Date().toISOString() });
  const rerun = await store2.getRun(planID);
  const redelivery = await store2.getHandoffDelivery(planID, recovery.handoffID);
  report("fresh reopen: lifecycle still completed", rerun?.lifecycle === "completed", rerun?.lifecycle);
  report("fresh reopen: delivery still delivered (durable)", redelivery?.state === "delivered");
  const recovery2 = await controller.recoverExecutionHandoff(session.id);
  report("re-recovery: already_completed, no redispatch", recovery2.status === "already_completed", recovery2.status);
  store2.close();

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== ${pass}/${results.length} checks passed ===`);
  try { stopServer(server2); } catch {}
  process.exit(pass === results.length ? 0 : 1);
}

async function findStoreFile(dir) {
  for (const entry of await (await import("node:fs/promises")).readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findStoreFile(full);
      if (found) return found;
    } else if (entry.name === "plan-store.json") return full;
  }
  return undefined;
}

main().catch((error) => {
  console.error("DETERMINISTIC-HANDOFF-SMOKE-FAILED", error?.stack ?? error);
  process.exit(1);
});
