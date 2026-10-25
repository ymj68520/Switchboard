#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import sqlite3 from "node:sqlite";
import { execFileSync } from "node:child_process";

const URL = "http://127.0.0.1:19327";
const REPO_ROOT = "E:/Projects/Switchboard";
const ISOLATED_ROOT = path.join(REPO_ROOT, ".tmp/claude-fullflow");
const WORKSPACE_DIR = path.join(ISOLATED_ROOT, "workspace");
const CONFIG_DIR = path.join(ISOLATED_ROOT, "config");
const EVIDENCE_DIR = path.join(ISOLATED_ROOT, "evidence");

const GOAL = "Append a line containing CLAUDE_LIVE_OK to notes.txt so that node check.js passes. Do not modify check.js.";
const TIMEOUT_MS = 600_000;

async function getScreen() {
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function sendInput(text) {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: text }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function stopServer() {
  await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stop: true }),
  }).catch(() => {});
}

async function pasteText(text) {
  for (let i = 0; i < text.length; i += 80) {
    await sendInput(text.slice(i, i + 80));
    await new Promise((r) => setTimeout(r, 80));
  }
  await new Promise((r) => setTimeout(r, 500));
  await sendInput("\r");
}

function findSqliteDb() {
  const pluginsDir = path.join(CONFIG_DIR, "plugins");
  if (!fs.existsSync(pluginsDir)) return null;
  function search(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        const found = search(full);
        if (found) return found;
      } else if (ent.name.endsWith(".sqlite3")) {
        return full;
      }
    }
    return null;
  }
  return search(pluginsDir);
}

async function main() {
  console.log("=== Claude TUI Controller Starting ===");
  const startTime = Date.now();
  const deadline = startTime + TIMEOUT_MS;

  // Wait for server readiness
  let serverUp = false;
  for (let i = 0; i < 30; i++) {
    try {
      await getScreen();
      serverUp = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!serverUp) {
    console.error("Claude TUI server did not become ready");
    process.exit(1);
  }

  let promptSent = false;
  let completedState = null;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    let state;
    try {
      state = await getScreen();
    } catch (err) {
      console.log(`Server disconnected: ${err.message}`);
      break;
    }
    if (state.exited) {
      console.log(`Claude process exited with code ${state.exited.exitCode}`);
      break;
    }

    const screen = state.screen;

    // Safety / trust dialog
    if (screen.includes("trust this folder") || screen.includes("Is this a project you created")) {
      console.log("[CONTROLLER] Handling workspace trust dialog -> selecting Yes");
      await sendInput("\x1b[B\r");
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    // Bypass permissions dialog
    if (screen.includes("Bypass Permissions mode") || screen.includes("Yes, I accept")) {
      console.log("[CONTROLLER] Handling bypass permissions dialog -> accepting");
      await sendInput("\x1b[B\r");
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    // Onboarding text style
    if (screen.includes("Let's get started") || screen.includes("Choose the text style") || screen.includes("Dark mode")) {
      console.log("[CONTROLLER] Handling onboarding text style -> accepting Dark mode");
      await sendInput("\r");
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    const hasDialog =
      screen.includes("trust") ||
      screen.includes("safety check") ||
      screen.includes("Bypass Permissions") ||
      screen.includes("Let's get started") ||
      screen.includes("Choose the text style");

    // Prompt ready
    if (!promptSent && !hasDialog && (screen.includes("Sonnet 4.6") || screen.includes("auto mode") || screen.includes("❯"))) {
      console.log(`[CONTROLLER] Claude prompt box ready. Sending /phase-plan command...`);
      await pasteText(`/phase-plan ${GOAL}`);
      promptSent = true;
      await new Promise((r) => setTimeout(r, 4000));
      continue;
    }

    // Permission request / approval dialogs
    if (
      screen.includes("Do you want to") ||
      screen.includes("Do you want to proceed?") ||
      screen.includes("approve") ||
      screen.includes("(Y/n)") ||
      screen.includes("[Y/n]") ||
      screen.includes("Allow once") ||
      screen.includes("Allow always")
    ) {
      console.log("[CONTROLLER] Dialog detected on screen -> auto-approving with Enter");
      await sendInput("\r");
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Confirmation prompts
    if (
      screen.includes("Should I proceed?") ||
      screen.includes("Ready to proceed?") ||
      screen.includes("Would you like me to proceed?")
    ) {
      console.log("[CONTROLLER] Text confirmation detected -> sending Yes");
      await pasteText("Yes, proceed.");
      await new Promise((r) => setTimeout(r, 3000));
    }

    // Check SQLite database for progress & completion
    const dbPath = findSqliteDb();
    if (dbPath && fs.existsSync(dbPath)) {
      try {
        const db = new sqlite3.DatabaseSync(dbPath, { open: true, readOnly: true });
        const runs = db.prepare("SELECT * FROM execution_runs").all();
        if (runs.length > 0) {
          const run = runs[0];
          const stages = db.prepare("SELECT * FROM execution_stages WHERE execution_run_id=?").all(run.execution_run_id);
          const commits = db.prepare("SELECT * FROM execution_commits WHERE execution_run_id=?").all(run.execution_run_id);
          const directives = db.prepare("SELECT * FROM execution_directives WHERE execution_run_id=?").all(run.execution_run_id);
          const attempts = db.prepare("SELECT * FROM execution_attempts WHERE execution_run_id=?").all(run.execution_run_id);
          const reports = db.prepare("SELECT * FROM execution_reports WHERE execution_run_id=?").all(run.execution_run_id);

          const completedStages = stages.filter((s) => s.status === "completed").length;
          console.log(`[HEARTBEAT] Run ${run.execution_run_id}: lifecycle=${run.lifecycle} stages=${completedStages}/${stages.length} commits=${commits.length} directives=${directives.length} reports=${reports.length}`);

          if (run.lifecycle === "completed") {
            console.log(`[SUCCESS] ExecutionRun ${run.execution_run_id} reached lifecycle=completed!`);
            completedState = {
              run,
              stages,
              commits,
              directives,
              attempts,
              reports,
            };
            break;
          }
        }
      } catch (err) {
        // Retry on read error
      }
    }
  }

  await stopServer();
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n=== Controller Finished in ${elapsed}s ===`);

  // Physical verification
  let testPass = false;
  try {
    const testOut = execFileSync("node", ["check.js"], { cwd: WORKSPACE_DIR }).toString().trim();
    testPass = testOut.includes("validation OK");
    console.log(`[PASS] Physical check.js output: ${testOut}`);
  } catch (err) {
    console.error(`[FAIL] Physical check.js failed: ${err.message}`);
  }

  const notesContent = fs.existsSync(path.join(WORKSPACE_DIR, "notes.txt"))
    ? fs.readFileSync(path.join(WORKSPACE_DIR, "notes.txt"), "utf8")
    : "";
  console.log(`[PASS] notes.txt content:\n${notesContent.trim()}`);

  const evidence = {
    verifiedAt: new Date().toISOString(),
    elapsedSeconds: elapsed,
    goal: GOAL,
    physicalCheckPass: testPass,
    notesContent,
    completedState,
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, "claude-fullflow-evidence.json"), JSON.stringify(evidence, null, 2), "utf8");

  if (testPass) {
    console.log("=== CLAUDE CODE FULL-FLOW VERIFICATION: PASS ===");
    process.exit(0);
  } else {
    console.error("=== CLAUDE CODE FULL-FLOW VERIFICATION: INCOMPLETE ===");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Controller error:", err);
  process.exit(1);
});
