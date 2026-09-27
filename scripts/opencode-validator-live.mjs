#!/usr/bin/env node
/**
 * Ultra Plan v0.1 RC — LIVE semantic-validator evidence (RR-03 / §29–§31).
 *
 * Drives a REAL planning run to synthesis/manifest-ready through the
 * sanctioned TEST-ONLY setup seam (zero model turns during setup), then
 * invokes the REAL production validator adapter — isolated session, strict
 * protocol prompt, REAL configured model, strict parser — through the REAL
 * controller path (run_semantic_validation).
 *
 * Records ONLY safe metadata (PlanID, manifest ref, report ref/result,
 * session hygiene, model identity). No hidden reasoning, no prompt bodies.
 *
 * Provider-cooperation policy: the strict parser is deterministically
 * tested; this gate proves INTEGRATION. If the free-tier model returns an
 * unparseable answer, run_semantic_validation fails closed
 * (validation_output_invalid) — up to 2 disclosed retries of the SAME
 * identity are allowed (idempotent anti-laundering returns the same report
 * for a replay); every attempt is recorded.
 *
 * Usage: node scripts/opencode-validator-live.mjs [model]
 */
import { spawn, execSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = path.join(repoRoot, "adapters", "opencode", "dist", "index.js");
const setupScript = path.join(repoRoot, "scripts", "opencode-handoff-setup.mjs");
const MODEL = process.argv[2] ?? "opencode/ling-3.0-flash-fin-free";
const PORT = 21000 + Math.floor(Math.random() * 30000);
const BASE = `http://127.0.0.1:${PORT}`;
const GOAL = `Validator live acceptance ${Date.now()}`;
const MAX_ATTEMPTS = 3; // 1 + 2 disclosed provider-cooperation retries

const results = [];
function report(step, ok, detail = "") {
  results.push({ step, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnServer(fixtureDir, port, dataDir) {
  return spawn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1", "--print-logs"], {
    cwd: fixtureDir,
    shell: true,
    env: { ...process.env, ULTRA_PLAN_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
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
async function findStoreFile(dir) {
  const fs = await import("node:fs/promises");
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findStoreFile(full);
      if (found) return found;
    } else if (entry.name === "plan-store.json") return full;
  }
  return undefined;
}

async function main() {
  if (!existsSync(distEntry)) {
    console.error(`dist entry not found: ${distEntry}\nRun: npm run build -w @switchboard/opencode`);
    process.exit(2);
  }
  const ultra = await import(pathToFileURL(distEntry).href);
  const { DurablePlanStore, UltraPlanController, OpenCodeSemanticValidator } = ultra;
  const { createOpencodeClient } = await import("@opencode-ai/sdk");

  const fixture = await mkdtemp(path.join(tmpdir(), "ultraplan-validator-"));
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

  const server = spawnServer(fixture, PORT, dataDir);
  const ready = await waitReady(BASE);
  report("server ready", ready);
  if (!ready) process.exit(1);
  const config = await (await fetch(`${BASE}/config`)).json();
  const configuredModel = config.model ?? MODEL;
  report("session default model identified (safe metadata)", Boolean(configuredModel), configuredModel);
  const session = await (await fetch(`${BASE}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "validator-live" }),
  })).json();
  report("REAL session created", Boolean(session.id), session.id);
  stopServer(server);
  await sleep(3000);

  // TEST-ONLY setup: create the run and drive to synthesis/manifest-ready.
  const setup = spawn(process.execPath, [setupScript, dataDir, session.id, "--create", GOAL, "--stop-at-manifest"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let setupOut = "";
  setup.stdout.on("data", (d) => (setupOut += String(d)));
  setup.stderr.on("data", (d) => (setupOut += String(d)));
  const setupCode = await new Promise((resolve) => setup.on("close", resolve));
  const finalLine = setupOut.split("\n").find((l) => l.includes("STOPPED_AT=manifest-ready")) ?? "";
  report("TEST-ONLY setup reached synthesis/manifest-ready (no model turns)", setupCode === 0 && finalLine.includes("STOPPED_AT=manifest-ready"), `exit=${setupCode}`);
  if (setupCode !== 0) {
    console.error(setupOut.slice(-1500));
    process.exit(1);
  }
  const planID = setupOut.match(/RUN=(PLAN-\d+)/)?.[1];

  // Restart the server over the SAME durable store (restart representation);
  // the validator's real model call needs the live host.
  const server2 = spawnServer(fixture, PORT, dataDir);
  const ready2 = await waitReady(BASE);
  report("server restarted over the same store", ready2);
  if (!ready2) process.exit(1);

  const store = new DurablePlanStore(await findStoreFile(dataDir), { now: () => new Date().toISOString() });
  const client = createOpencodeClient({ baseUrl: BASE });
  const controller = new UltraPlanController({
    store,
    now: () => new Date().toISOString(),
    // THE THING UNDER TEST: the REAL production validator adapter.
    semanticValidator: new OpenCodeSemanticValidator(client),
  });

  const sessionsBefore = (await (await fetch(`${BASE}/session`)).json()).length;
  let outcome;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      outcome = await controller.runSemanticValidation(session.id);
      console.log(`ATTEMPT ${attempt}: accepted (result=${outcome.report?.result ?? "?"})`);
      break;
    } catch (error) {
      const code = error?.code ?? "unknown";
      console.log(`ATTEMPT ${attempt}: ${code} — ${String(error?.message ?? error).slice(0, 140)}`);
      if (attempt === MAX_ATTEMPTS || (code !== "validation_output_invalid" && code !== "validator_unavailable")) throw error;
      // disclosed provider-cooperation retry: same identity, anti-laundering-safe
    }
  }
  const sessionsAfter = (await (await fetch(`${BASE}/session`)).json()).length;
  report("run_semantic_validation returned a REAL report through the real adapter", Boolean(outcome?.report), outcome?.report ? `${outcome.report.id} result=${outcome.report.result}` : "none");
  report("validator result strictly parsed", outcome?.report?.result === "clean" || outcome?.report?.result === "findings", outcome?.report?.result);
  report("ephemeral validator session deleted (session count net-zero)", sessionsAfter === sessionsBefore, `${sessionsBefore} -> ${sessionsAfter}`);
  const run = await store.getRun(planID);
  report("run stage still synthesis (validation is non-persisted state)", run?.stage === "synthesis", run?.stage);
  store.close();

  console.log(`\nMETADATA planID=${planID} report=${outcome?.report?.id ?? "none"} result=${outcome?.report?.result ?? "none"} model=${configuredModel}`);
  const pass = results.filter((r) => r.ok).length;
  console.log(`=== ${pass}/${results.length} checks passed ===`);
  try { stopServer(server2); } catch {}
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error("VALIDATOR-LIVE-FAILED", error?.stack ?? error);
  process.exit(1);
});
