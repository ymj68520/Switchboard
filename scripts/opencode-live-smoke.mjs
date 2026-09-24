#!/usr/bin/env node
/**
 * Live OpenCode runtime validation for the Ultra Plan plugin (Phase 2A).
 *
 * Boots a real `opencode serve` process against a generated fixture project
 * that loads the BUILT plugin (adapters/opencode/dist), then verifies over the
 * real HTTP API:
 *
 *   1. plugin loads (server starts without plugin errors)
 *   2. config hook executes  → /ultra-plan command + ultraplan agent present
 *   3. Ultra Plan tools are exposed (incl. ultraplan_start)
 *   4. /ultra-plan command executes on a REAL session via /session/{id}/command
 *   5. ToolContext carries a real sessionID; PlanningRun(discovery) is created
 *   6. second invocation RESUMES the same run (no second run)
 *   7. deterministic status text is returned
 *   8. no second OpenCode session is created
 *
 * Requires network access for model inference (uses the free `opencode/*`
 * gateway model by default). Prints PASS/FAIL per criterion and exits
 * non-zero if infrastructure or assertions fail. A model-auth failure is
 * reported as LIVE RUNTIME VALIDATION BLOCKED with the exact provider error.
 *
 * Usage: node scripts/opencode-live-smoke.mjs [model]
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = path.join(repoRoot, "adapters", "opencode", "dist", "index.js");
const MODEL = process.argv[2] ?? "opencode/ling-3.0-flash-fin-free";
const PORT = 20000 + Math.floor(Math.random() * 20000);
const COMMAND_TIMEOUT_MS = 300_000;

const results = [];
function report(step, ok, detail = "") {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  if (!existsSync(distEntry)) {
    console.error(`dist entry not found: ${distEntry}\nRun: npm run build -w @switchboard/opencode`);
    process.exit(2);
  }

  const fixture = await mkdtemp(path.join(tmpdir(), "ultraplan-smoke-"));
  const dataDir = path.join(fixture, "ultra-plan-data"); // durable store location (restart-safe)
  await mkdir(path.join(fixture, ".opencode", "plugin"), { recursive: true });
  await writeFile(
    path.join(fixture, ".opencode", "plugin", "ultra-plan.js"),
    `export { default } from ${JSON.stringify(pathToFileURL(distEntry).href)};\n`,
  );
  await writeFile(
    path.join(fixture, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        model: MODEL,
        share: "disabled",
        autoupdate: false,
      },
      null,
      2,
    ),
  );
  console.log(`fixture: ${fixture}\nmodel:   ${MODEL}\n`);

  const serverLog = [];
  const serverPids = [];

  function spawnServer(fixtureDir, port) {
    const proc = spawn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1", "--print-logs"], {
      cwd: fixtureDir,
      shell: true,
      env: { ...process.env, ULTRA_PLAN_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    serverPids.push(proc.pid);
    proc.stdout.on("data", (d) => serverLog.push(String(d)));
    proc.stderr.on("data", (d) => serverLog.push(String(d)));
    proc.on("exit", (code) => serverLog.push(`[server (pid=${proc.pid}) exited code=${code}]`));
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

  const PORT2 = PORT + 1;
  const server = spawnServer(fixture, PORT);
  const server2Holder = { proc: null };

  const base = `http://127.0.0.1:${PORT}`;
  let pluginLoaded = false;
  try {
    // -- wait for the server -------------------------------------------------
    let up = false;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      try {
        const res = await fetch(`${base}/config`);
        if (res.ok) { up = true; break; }
      } catch { /* not up yet */ }
    }
    if (!up) throw new Error("opencode serve did not become ready in 60s");
    report("opencode serve starts and serves HTTP", true, base);

    const pluginErrors = serverLog.join("").match(/plugin[^\n]*error[^\n]*/gi);
    pluginLoaded = !pluginErrors;
    report("plugin loads without errors", pluginLoaded, pluginErrors?.[0] ?? "");

    // -- config hook ---------------------------------------------------------
    const config = await (await fetch(`${base}/config`)).json();
    const command = config.command?.["ultra-plan"];
    report(
      "config hook registered /ultra-plan command",
      Boolean(command?.template) && command?.agent === "ultraplan",
      command ? `agent=${command.agent} model=${command.model ?? "(inherit)"}` : "missing",
    );
    const agent = config.agent?.["ultraplan"];
    report(
      "config hook registered ultraplan planning agent",
      agent?.mode === "primary",
      agent ? `mode=${agent.mode} model=${agent.model ?? "(explicit default inheritance)"}` : "missing",
    );

    // -- tool exposure ---------------------------------------------------------
    let toolIds = [];
    try {
      const res = await fetch(`${base}/experimental/tool/ids`);
      const body = await res.json();
      toolIds = Array.isArray(body) ? body : (body.data ?? body.tools ?? []);
    } catch (error) {
      report("tool ids endpoint reachable", false, String(error));
    }
    const ultraplanTools = toolIds.filter((id) => String(id).includes("ultraplan") || String(id).includes("plan_memory"));
    report(
      "Ultra Plan tools exposed to the runtime",
      ultraplanTools.length >= 8,
      ultraplanTools.length ? `found: ${ultraplanTools.join(", ")}` : `none (ids: ${toolIds.slice(0, 20).join(", ")})`,
    );

    // -- real session + /ultra-plan ------------------------------------------
    const sessionRes = await fetch(`${base}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const session = await sessionRes.json();
    const sessionID = session.id ?? session.data?.id;
    report("session created", Boolean(sessionID), sessionID ?? JSON.stringify(session));

    const sessionsBefore = await (await fetch(`${base}/session`)).json();
    const beforeCount = Array.isArray(sessionsBefore) ? sessionsBefore.length : sessionsBefore.data?.length;

    // -- explicit-entry boundary: model-invoked tool WITHOUT the command -----
    const probe = await promptAndWait(base, sessionID,
      "Call the ultraplan_start tool now with no arguments, then report its result verbatim.",
      /start_not_authorized/,
    );
    report(
      "model-invoked ultraplan_start WITHOUT /ultra-plan is DENIED (start_not_authorized)",
      probe.ok,
      probe.detail,
    );
    const probePlan = !(probe.text ?? "").includes("Plan: PLAN-001");
    report("no PlanningRun was created by the denied call", probePlan, probePlan ? "" : "PLAN-001 appeared in denied-probe output");

    // -- explicit command admission ------------------------------------------
    const firstRun = await executeCommand(base, sessionID, "Plan the Switchboard router");
    report(
      "/ultra-plan creates PlanningRun(discovery) with real sessionID (first invocation)",
      firstRun.ok,
      firstRun.detail,
    );
    report("deterministic status block returned", /Plan: PLAN-001/.test(firstRun.text ?? ""), excerpt(firstRun.text));

    const secondRun = await executeCommand(base, sessionID, "");
    report(
      "second /ultra-plan RESUMES the same run (created=false path)",
      secondRun.ok && /PLAN-001/.test(secondRun.text ?? ""),
      secondRun.detail,
    );

    const sessionsAfter = await (await fetch(`${base}/session`)).json();
    const afterCount = Array.isArray(sessionsAfter) ? sessionsAfter.length : sessionsAfter.data?.length;
    report(
      "no second OpenCode session was created",
      afterCount === beforeCount,
      `before=${beforeCount} after=${afterCount}`,
    );

    // -- REAL server restart: durable PlanningRun must resume (§35) ----------
    await killTree(server);
    await sleep(2000);
    const server2 = spawnServer(fixture, PORT2);
    server2Holder.proc = server2;
    const base2 = `http://127.0.0.1:${PORT2}`;
    let up2 = false;
    for (let i = 0; i < 45; i++) {
      await sleep(1000);
      try {
        const res = await fetch(`${base2}/config`);
        if (res.ok) { up2 = true; break; }
      } catch { /* not up yet */ }
    }
    if (!up2) throw new Error("restarted opencode server did not become ready");

    // Sessions are restored by OpenCode itself; find the SAME session.
    const sessionsRestored = await (await fetch(`${base2}/session`)).json();
    const restoredIDs = (Array.isArray(sessionsRestored) ? sessionsRestored : sessionsRestored.data ?? []).map((x) => x.id);
    report("sessions survive the server restart", restoredIDs.includes(sessionID), restoredIDs.join(", ").slice(0, 120));

    const restartRun = await executeCommand(base2, sessionID, "");
    report(
      "/ultra-plan after a REAL server restart RESUMES the same durable PlanningRun (§35)",
      restartRun.ok && /PLAN-001/.test(restartRun.text ?? "") && !/PLAN-002/.test(restartRun.text ?? ""),
      restartRun.detail,
    );
  } catch (error) {
    report("live validation aborted", false, String(error));
  } finally {
    // Kill the whole process tree — server.kill() alone orphans opencode.exe
    // behind the shell and keeps our stdio pipes open.
    for (const pid of serverPids) {
      if (process.platform === "win32") {
        await new Promise((resolve) => {
          const taskkill = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { shell: true });
          taskkill.on("exit", resolve);
          taskkill.on("error", resolve);
        });
      } else {
        process.kill(pid, "SIGKILL");
      }
    }
    await sleep(500);
    await rm(fixture, { recursive: true, force: true }).catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  if (failed.length > 0) {
    const providerBlocked = failed.some(
      (f) => /401|403|api key|auth|credential|exceeded|quota/i.test(f.detail),
    );
    if (providerBlocked) {
      console.log("\nLIVE RUNTIME VALIDATION BLOCKED — provider/model error (see details above).");
    }
    dumpServerLog(serverLog);
    process.exit(1);
  }
  // Explicit exit: piped stdio to a spawned server can otherwise keep the
  // event loop alive after main() completes.
  process.exit(0);
}

/**
 * Send a plain user message (NOT a /ultra-plan command) and wait until the
 * session log matches the given pattern.
 */
async function promptAndWait(base, sessionID, text, pattern) {
  const res = await fetch(`${base}/session/${sessionID}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text }] }),
  });
  if (!res.ok) {
    return { ok: false, text: "", detail: `prompt endpoint ${res.status}: ${(await res.text()).slice(0, 300)}` };
  }
  const deadline = Date.now() + COMMAND_TIMEOUT_MS;
  let lastTexts = "";
  while (Date.now() < deadline) {
    await sleep(3000);
    let messages;
    try {
      messages = await (await fetch(`${base}/session/${sessionID}/message`)).json();
    } catch { continue; }
    const list = Array.isArray(messages) ? messages : (messages.data ?? []);
    lastTexts = JSON.stringify(list);
    if (pattern.test(lastTexts)) {
      return { ok: true, text: lastTexts, detail: "denied with structured start_not_authorized error" };
    }
    if (/"type":"error"/i.test(lastTexts) || /ProviderError|api key|Unauthorized|"code":40[13]/i.test(lastTexts)) {
      return { ok: false, text: lastTexts, detail: `provider/model error: ${matchError(lastTexts)}` };
    }
  }
  return { ok: false, text: lastTexts, detail: `timeout waiting for ${pattern}` };
}

async function executeCommand(base, sessionID, args) {
  const res = await fetch(`${base}/session/${sessionID}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "ultra-plan", arguments: args }),
  });
  if (!res.ok) {
    return { ok: false, text: "", detail: `command endpoint ${res.status}: ${(await res.text()).slice(0, 300)}` };
  }

  const deadline = Date.now() + COMMAND_TIMEOUT_MS;
  let lastTexts = "";
  while (Date.now() < deadline) {
    await sleep(3000);
    let messages;
    try {
      messages = await (await fetch(`${base}/session/${sessionID}/message`)).json();
    } catch { continue; }
    const list = Array.isArray(messages) ? messages : (messages.data ?? []);
    lastTexts = JSON.stringify(list);
    if (/"ultraplan_start"/.test(lastTexts) && /Plan: PLAN-001/.test(lastTexts)) {
      const resumed = /resumed/.test(lastTexts);
      return { ok: true, text: lastTexts, detail: `ultraplan_start executed${resumed ? " (resume path)" : " (create path)"}` };
    }
    if (/"type":"error"/i.test(lastTexts) || /ProviderError|api key|Unauthorized|"code":40[13]/i.test(lastTexts)) {
      return { ok: false, text: lastTexts, detail: `provider/model error: ${matchError(lastTexts)}` };
    }
  }
  return { ok: false, text: lastTexts, detail: `timeout after ${COMMAND_TIMEOUT_MS / 1000}s waiting for ultraplan_start` };
}

function matchError(text) {
  const match = text.match(/"(error|message)"\s*:\s*"([^"]{10,300})"/i);
  return match ? match[2] : text.slice(0, 200);
}

function excerpt(text) {
  const match = (text ?? "").match(/Ultra Plan\\n\\nPlan: PLAN-001[^\\"]{0,220}/);
  return match ? match[0].slice(0, 240) : "(status block not found)";
}

function dumpServerLog(log) {
  const tail = log.join("").split("\n").slice(-40).join("\n");
  console.log("\n--- server log tail ---\n" + tail);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
