#!/usr/bin/env node
/**
 * R2 live OpenCode validation — context architecture + REAL compaction
 * (brief §70-§77).
 *
 * Boots a real `opencode serve` against a fixture project loading the BUILT
 * plugin, then proves over the real HTTP API:
 *
 *   1. server + plugin load (same infra as opencode-live-smoke.mjs)
 *   2. /ultra-plan creates the run (unique user-authored goal marker)
 *   3. §75: experimental.chat.system.transform REALLY executes the Context
 *      Assembler for a real planning model request — proven by the structured
 *      `ultraplan.context.trace` diagnostic the hook emits (§72/§73: the model
 *      is NEVER asked to repeat its prompt).
 *   4. §76: L2 fragments (goal) are automatically included in the live trace —
 *      no plan_memory call was made.
 *   5. discovery → architecture moves the live run; the next trace reflects it.
 *   6. §70/§71: REAL host compaction is triggered over the verified primitive
 *      (POST /session/{id}/summarize — the TUI "session.compact" path), the
 *      session's conversation is summarized away, and the NEXT planning
 *      inference reconstructs the same authoritative context: same PlanID,
 *      same stage, L0 protocol + L1 run state + L2 goal + L5 operations again
 *      — committed planning context survives conversation compaction.
 *
 * Headless boundary (standing, honest): interactive approvals cannot be given
 * by a headless run, so a committed ARCH/active-Section cannot be seeded live;
 * the L2 constraint/ARCH fragments and the section active-scope retrieval are
 * pinned by the deterministic suite (test/context-architecture.test.ts) and
 * the goal/protocol/run-state/operations layers are proven here at L level.
 *
 * Usage: node scripts/opencode-context-smoke.mjs [model]
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = path.join(repoRoot, "adapters", "opencode", "dist", "index.js");
const MODEL = process.argv[2] ?? "opencode/ling-3.0-flash-fin-free";
const PORT = 40000 + Math.floor(Math.random() * 15000);
const COMMAND_TIMEOUT_MS = 300_000;
const GOAL_MARKER = `R2CTXMARKER-8241 deterministic context pipeline`;

const results = [];
function report(step, ok, detail = "") {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
}

/** Non-scoring observation (host scheduling details, environment notes). */
function note(step, detail = "") {
  console.log(`NOTE  ${step}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Extract parsed ultraplan.context.trace objects from the RAW server output.
 * The host logger does not reliably terminate its lines with newlines, so the
 * trace JSON can be concatenated with host log text on the same "line" —
 * extraction therefore locates each `{"channel":…}` marker and takes the
 * brace-balanced object that follows (the trace JSON contains no braces
 * inside string values, so brace counting is exact).
 */
export function parseTraceLines(rawLog) {
  const traces = [];
  const marker = '{"channel":"ultraplan.context.trace"';
  let index = rawLog.indexOf(marker);
  while (index >= 0) {
    let depth = 0;
    let end = -1;
    for (let i = index; i < rawLog.length; i++) {
      if (rawLog[i] === "{") depth++;
      else if (rawLog[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end > index) {
      try {
        const parsed = JSON.parse(rawLog.slice(index, end));
        if (parsed.channel === "ultraplan.context.trace") traces.push(parsed);
      } catch {
        /* truncated tail — skip */
      }
    }
    index = rawLog.indexOf(marker, index + marker.length);
  }
  return traces;
}

function includedFragment(trace, fragmentId) {
  return trace.included.find((entry) => entry.fragmentId === fragmentId);
}

async function main() {
  if (!existsSync(distEntry)) {
    console.error(`dist entry not found: ${distEntry}\nRun: npm run build -w @switchboard/opencode`);
    process.exit(2);
  }

  const fixture = await mkdtemp(path.join(tmpdir(), "ultraplan-ctx-smoke-"));
  const dataDir = path.join(fixture, "ultra-plan-data");
  await mkdir(path.join(fixture, ".opencode", "plugin"), { recursive: true });
  await writeFile(
    path.join(fixture, ".opencode", "plugin", "ultra-plan.js"),
    `export { default } from ${JSON.stringify(pathToFileURL(distEntry).href)};\n`,
  );
  await writeFile(
    path.join(fixture, "opencode.json"),
    JSON.stringify(
      { $schema: "https://opencode.ai/config.json", model: MODEL, share: "disabled", autoupdate: false },
      null,
      2,
    ),
  );
  console.log(`fixture: ${fixture}\nmodel:   ${MODEL}\n`);

  const serverLog = [];
  const serverPids = [];
  // Line-buffered capture: stream chunks can split a JSON line across
  // "data" events, which would make the trace parser silently drop lines.
  const lineBuffers = { out: "", err: "" };
  const pushLines = (channel, chunk) => {
    lineBuffers[channel] += chunk;
    const parts = lineBuffers[channel].split("\n");
    lineBuffers[channel] = parts.pop() ?? "";
    for (const line of parts) serverLog.push(line);
  };
  const proc = spawn("opencode", ["serve", "--port", String(PORT), "--hostname", "127.0.0.1", "--print-logs"], {
    cwd: fixture,
    shell: true,
    env: { ...process.env, ULTRA_PLAN_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverPids.push(proc.pid);
  proc.stdout.on("data", (d) => pushLines("out", String(d)));
  proc.stderr.on("data", (d) => pushLines("err", String(d)));
  proc.on("exit", (code) => serverLog.push(`[server exited code=${code}]`));

  // The line buffer's pending tail is part of the raw view: the host logger
  // does not always emit trailing newlines, so a freshly written trace line
  // may sit unflushed in the buffer for a long time.
  const rawLog = () => serverLog.join("") + lineBuffers.out + lineBuffers.err;
  const base = `http://127.0.0.1:${PORT}`;
  let failures = 0;
  try {
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

    const pluginErrors = rawLog().match(/plugin[^\n]*error[^\n]*/gi);
    report("plugin loads without errors", !pluginErrors, pluginErrors?.[0] ?? "");

    // -- real session + /ultra-plan with the unique goal marker --------------
    const session = await (await fetch(`${base}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    const sessionID = session.id ?? session.data?.id;
    report("session created", Boolean(sessionID), sessionID ?? "");

    const commandRes = await fetch(`${base}/session/${sessionID}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "ultra-plan", arguments: GOAL_MARKER }),
    });
    report("/ultra-plan command accepted", commandRes.ok, `status ${commandRes.status}`);
    const ran = await waitFor(() => {
      const traces = parseTraceLines(rawLog());
      return traces.length > 0 ? traces : null;
    }, "first ultraplan.context.trace");
    if (!ran.ok) throw new Error(ran.detail);
    const traceA = ran.value.at(-1);
    report(
      "§75 system-transform executed the assembler for a REAL model request (trace emitted)",
      traceA.planID === "PLAN-001" && traceA.stage === "discovery",
      `planID=${traceA.planID} stage=${traceA.stage} totalTokens=${traceA.totalTokens}`,
    );
    report(
      "§73 trace carries the exact authority identity (PlanID/HEAD/stage) — no prompt content",
      traceA.planID === "PLAN-001" &&
        Object.keys(traceA).every((key) => ["channel", "id", "planID", "headCommit", "stage", "activeWork", "budget", "overBudget", "totalTokens", "included", "excluded"].includes(key)),
      `head=${traceA.headCommit ?? "none"} budget=${traceA.budget}`,
    );
    report(
      "§76 L0+L1+L5 fragments automatic in the live trace",
      [includedFragment(traceA, "L0:protocol"), includedFragment(traceA, "L1:run-state"), includedFragment(traceA, "L5:capabilities")].every(Boolean),
      "L0 protocol, L1 run state, L5 operations included",
    );
    report(
      "§76 L2 goal fragment automatic (unique user-authored goal, NO plan_memory call)",
      Boolean(includedFragment(traceA, "L2:goal")) && traceA.stage === "discovery",
      "goal included at P0 before any explicit memory read",
    );

    // Wait for the command turn itself to settle, then move to architecture.
    const settled = await waitFor(async () => {
      const text = await rawSessionText(base, sessionID);
      return /Plan: PLAN-001/.test(text) ? true : null;
    }, "status block in session history");
    report("/ultra-plan produced the deterministic status block", settled.ok, settled.detail ?? "");

    // -- discovery -> architecture (live model invocation) -------------------
    // Model cooperation varies on the free gateway tier; retry the prompt a
    // few times before declaring the leg failed.
    let archTraces = { ok: false, value: undefined, detail: "not attempted" };
    for (let attempt = 1; attempt <= 3 && !archTraces.ok; attempt++) {
      const promptRes = await fetch(`${base}/session/${sessionID}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: "Call the ultraplan_request_architecture tool now (it needs no arguments). Then report its result verbatim." }] }),
      });
      if (!promptRes.ok) {
        report("prompt accepted", false, `status ${promptRes.status}`);
        break;
      }
      archTraces = await waitFor(() => {
        const traces = parseTraceLines(rawLog()).filter((trace) => trace.stage === "architecture");
        return traces.length > 0 ? traces : null;
      }, `trace with stage=architecture (attempt ${attempt})`);
    }
    const traceB = archTraces.ok ? archTraces.value.at(-1) : undefined;
    report(
      "discovery -> architecture moved live; the next trace reflects the new stage",
      archTraces.ok && traceB.planID === "PLAN-001",
      archTraces.ok ? `stage=${traceB.stage} planID=${traceB.planID}` : archTraces.detail,
    );

    // -- §70/§71: REAL host compaction ----------------------------------------
    // Verified primitive audit (§70): OpenCode 1.18.x exposes
    //   - POST /session/{id}/summarize (the TUI session.compact path),
    //   - the session.compacted event,
    //   - the experimental.session.compacting / experimental.compaction.
    //     autocontinue plugin hooks.
    // We trigger the REAL summarize flow and watch for the compaction message.
    const slash = MODEL.indexOf("/");
    const providerID = MODEL.slice(0, slash);
    const modelID = MODEL.slice(slash + 1);
    const summarizeRes = await fetch(`${base}/session/${sessionID}/summarize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerID, modelID }),
    });
    report("REAL compaction triggered via POST /session/{id}/summarize", summarizeRes.ok, `status ${summarizeRes.status}`);
    const compacted = await waitFor(async () => {
      try {
        const messages = await (await fetch(`${base}/session/${sessionID}/message`)).json();
        const list = Array.isArray(messages) ? messages : (messages.data ?? []);
        // Compaction appears as a PART (CompactionPart, type="compaction")
        // inside the session history, not as a message info type.
        return JSON.stringify(list).includes('"type":"compaction"') ? true : null;
      } catch {
        return null;
      }
    }, "compaction message in session history");
    report("session.compacted: the conversation was really summarized away", compacted.ok, compacted.detail ?? "");

    // The compaction pipeline ends with a synthetic autocontinue turn on the
    // same session. Under free-tier rate limits the host may sit in "retry"
    // backoff for a long time, so this is an INFORMATIONAL wait — the §71
    // assertions below wait for the actual post-compaction request instead.
    const idle = await waitFor(async () => {
      try {
        const statuses = await (await fetch(`${base}/session/status`)).json();
        const status = statuses?.[sessionID] ?? statuses?.data?.[sessionID];
        return status?.type === "idle" ? true : null;
      } catch {
        return null;
      }
    }, "session idle after compaction (informational)", 180_000);
    // Host scheduling detail, not a correctness property: under free-tier rate
    // limits the session may sit in retry/backoff well past the wait. The §71
    // assertions below gate the compaction proof; this is an observation only.
    if (idle.ok) {
      report("session idle again after the compaction pipeline", true, "idle");
    } else {
      note("session idle not observed within 180s (host retry/backoff) — informational; §71 checks below are the compaction gate");
    }

    // -- next planning inference after compaction -----------------------------
    // Baseline BEFORE the prompt: the synchronous /message POST only returns
    // after the assistant turn completed, so its traces are already in the log
    // by the time it resolves — the baseline must not swallow them.
    const baselineCount = parseTraceLines(rawLog()).length;
    const afterRes = await fetch(`${base}/session/${sessionID}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "Call the ultraplan_status tool now and report its result verbatim." }] }),
    });
    report("post-compaction planning prompt accepted", afterRes.ok, `status ${afterRes.status}`);
    // The compaction pipeline (summary inference + synthetic autocontinue
    // turn) runs on the same free-tier model and can hold the session for
    // several minutes; the post-compaction wait gets a generous deadline.
    const postTraces = await waitFor(() => {
      const traces = parseTraceLines(rawLog());
      if (traces.length <= baselineCount) return null;
      // The post-compaction request lands on the SAME session/run; the §71
      // assertions compare the actual pre/post trace pair (stage-agnostic —
      // never a scripted stage).
      return traces;
    }, "post-compaction planning trace", 600_000);
    const traceC = postTraces.ok ? postTraces.value.at(-1) : undefined;

    // §71 assertions: committed planning context must not change.
    report(
      "§71 same PlanID after REAL compaction",
      postTraces.ok && traceC.planID === traceB.planID && traceB.planID === "PLAN-001",
      postTraces.ok ? `pre=${traceB.planID} post=${traceC.planID}` : postTraces.detail,
    );
    report(
      "§71 same stage after REAL compaction",
      postTraces.ok && traceC.stage === traceB.stage,
      postTraces.ok ? `stage=${traceC.stage}` : postTraces.detail,
    );
    report(
      "§71 required L0-L5 reconstructed from durable authority after compaction",
      postTraces.ok &&
        [includedFragment(traceC, "L0:protocol"), includedFragment(traceC, "L1:run-state"), includedFragment(traceC, "L2:goal"), includedFragment(traceC, "L5:capabilities")].every(Boolean),
      postTraces.ok ? "protocol/run-state/goal/operations all present in the post-compaction trace" : postTraces.detail,
    );
    report(
      "§71 active-scope authority (activeWork) unchanged by compaction",
      postTraces.ok && JSON.stringify(traceC.activeWork ?? null) === JSON.stringify(traceB.activeWork ?? null),
      postTraces.ok ? `activeWork=${JSON.stringify(traceC.activeWork ?? null)}` : postTraces.detail,
    );
  } catch (error) {
    failures += 1;
    console.error("SMOKE ERROR:", error);
  } finally {
    await killTree(proc);
  }

  failures += results.filter((r) => !r.ok).length;
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  if (failures > 0) {
    dumpServerLog(serverLog);
    process.exit(1);
  }
}

/** Poll until resolve(value) returns non-null; value is the result. */
async function waitFor(resolve, label, timeoutMs = COMMAND_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastDetail = `timeout waiting for ${label}`;
  while (Date.now() < deadline) {
    await sleep(3000);
    try {
      const value = await resolve();
      if (value !== null && value !== undefined) return { ok: true, value, detail: "" };
    } catch (error) {
      lastDetail = String(error);
    }
  }
  return { ok: false, value: undefined, detail: lastDetail };
}

function rawSessionText(base, sessionID) {
  return fetch(`${base}/session/${sessionID}/message`)
    .then((res) => res.text())
    .catch(() => "");
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

function dumpServerLog(log) {
  const tail = log.join("").split("\n").slice(-40).join("\n");
  console.log("\n--- server log tail ---\n" + tail);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
