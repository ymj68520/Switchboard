#!/usr/bin/env node
/**
 * Real Claude Code Full-Flow Verification Suite (v0.2.0 Architecture & Amendment A2).
 *
 * Runs the isolated Claude Code binary under a real ConPTY with the built
 * phase-plan plugin against the local provider (http://127.0.0.1:8045), drives
 * the full planning and execution lifecycle, and monitors metrics.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import sqlite3 from "node:sqlite";

const require = createRequire(
  "C:/Users/Administrator/AppData/Local/Temp/opencode/switchboard-claude-v020/node_modules/dummy.js"
);
const pty = require("@lydell/node-pty");
const xterm = require("@xterm/headless");

const REPO_ROOT = "E:/Projects/Switchboard";
const TOOLS_NODE_DIR = "C:/Users/Administrator/AppData/Local/Temp/switchboard-v02-tools/node-v24.21.0-win-x64";
const ISOLATED_ROOT = path.join(REPO_ROOT, ".tmp/claude-fullflow");
const WORKSPACE_DIR = path.join(ISOLATED_ROOT, "workspace");
const CONFIG_DIR = path.join(ISOLATED_ROOT, "config");
const EVIDENCE_DIR = path.join(ISOLATED_ROOT, "evidence");
const CLAUDE_EXE = path.join(REPO_ROOT, ".tmp/isolated-claude-env/node_modules/@anthropic-ai/claude-code/bin/claude.exe");
const PLUGIN_DIR = path.join(REPO_ROOT, "adapters/claude-code");

const GOAL = "Append a line containing CLAUDE_LIVE_OK to notes.txt so that node check.js passes. Do not modify check.js.";
const TIMEOUT_MS = 600_000;

console.log("=== Starting Claude Code Full-Flow Verification ===");
console.log(`Isolated Root: ${ISOLATED_ROOT}`);
console.log(`Plugin Dir:    ${PLUGIN_DIR}`);
console.log(`Claude Binary: ${CLAUDE_EXE}`);

// 1. Prepare Workspace & Config directories
fs.rmSync(ISOLATED_ROOT, { recursive: true, force: true });
for (const dir of [WORKSPACE_DIR, CONFIG_DIR, EVIDENCE_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// 2. Initialize Git Repository in Workspace
execFileSync("git", ["init", "-q"], { cwd: WORKSPACE_DIR });
execFileSync("git", ["config", "user.email", "claude-flow@local"], { cwd: WORKSPACE_DIR });
execFileSync("git", ["config", "user.name", "Claude Flow Tester"], { cwd: WORKSPACE_DIR });

fs.writeFileSync(path.join(WORKSPACE_DIR, "notes.txt"), "baseline line one\n", "utf8");
fs.writeFileSync(
  path.join(WORKSPACE_DIR, "check.js"),
  [
    "const fs = require('fs');",
    "const text = fs.readFileSync('notes.txt', 'utf8');",
    "if (!text.includes('CLAUDE_LIVE_OK')) {",
    "  console.error('notes.txt lacks CLAUDE_LIVE_OK');",
    "  process.exit(1);",
    "}",
    "console.log('validation OK: CLAUDE_LIVE_OK present');",
    "",
  ].join("\n"),
  "utf8"
);

execFileSync("git", ["add", "-A"], { cwd: WORKSPACE_DIR });
execFileSync("git", ["commit", "-qm", "initial baseline commit"], { cwd: WORKSPACE_DIR });

// 3. Write Settings for Isolated Claude Code
const settings = {
  env: {
    ANTHROPIC_API_KEY: "sk-329920ed77ee41f18998953e3175c616",
    ANTHROPIC_AUTH_TOKEN: "sk-329920ed77ee41f18998953e3175c616",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:8045",
    ANTHROPIC_MODEL: "claude-sonnet-4-6",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-sonnet-4-6",
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "claude-sonnet-4-6",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-6",
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "claude-sonnet-4-6",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-sonnet-4-6",
    ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: "claude-sonnet-4-6",
    CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-4-6",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  },
  model: "claude-sonnet-4-6",
  permissions: {
    allow: [
      "mcp__plugin_phase-plan_phase-plan__*",
      "Bash",
      "Read",
      "Edit",
      "Write",
      "Glob",
      "Grep",
    ],
  },
};
fs.writeFileSync(path.join(CONFIG_DIR, "settings.json"), JSON.stringify(settings, null, 2), "utf8");

const initialClaudeJson = {
  hasCompletedOnboarding: true,
  theme: "dark",
  numStartups: 1,
  projects: {
    [WORKSPACE_DIR]: {
      hasTrustDialogAccepted: true,
    },
    [WORKSPACE_DIR.replace(/\//g, "\\")]: {
      hasTrustDialogAccepted: true,
    },
  },
};
fs.writeFileSync(path.join(CONFIG_DIR, ".claude.json"), JSON.stringify(initialClaudeJson, null, 2), "utf8");

// 4. Setup PTY & Terminal
const terminal = new xterm.Terminal({ cols: 140, rows: 45, scrollback: 5000, allowProposedApi: true });
const rawLogStream = fs.createWriteStream(path.join(EVIDENCE_DIR, "claude-tui.raw.log"), { flags: "a" });
const actionLogStream = fs.createWriteStream(path.join(EVIDENCE_DIR, "claude-actions.jsonl"), { flags: "a" });

function logAction(action, detail = {}) {
  const entry = { at: new Date().toISOString(), action, ...detail };
  actionLogStream.write(JSON.stringify(entry) + "\n");
  console.log(`[ACTION] ${action} ${Object.keys(detail).length ? JSON.stringify(detail) : ""}`);
}

const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: CONFIG_DIR,
  PATH: `${TOOLS_NODE_DIR}${path.delimiter}${process.env.PATH}`,
  TERM: "xterm-256color",
};

const child = pty.spawn(CLAUDE_EXE, ["--plugin-dir", PLUGIN_DIR], {
  cwd: WORKSPACE_DIR,
  env,
  cols: 140,
  rows: 45,
  name: "xterm-256color",
});

terminal.onData((data) => child.write(data));
child.onData((data) => {
  rawLogStream.write(data);
  terminal.write(data);
});

let ptyExitCode = null;
child.onExit((e) => {
  ptyExitCode = e.exitCode;
  logAction("pty_exit", { exitCode: e.exitCode });
  rawLogStream.end();
  actionLogStream.end();
});

function getScreenText() {
  const b = terminal.buffer.active;
  const lines = [];
  for (let i = 0; i < b.length; i++) {
    lines.push(b.getLine(i)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

function sendInput(text) {
  child.write(text);
}

// 5. Database Locator
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

// 6. Main Orchestration Loop
const startTime = Date.now();
let phasePlanInvoked = false;
let completedVerification = null;

async function runLoop() {
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline && ptyExitCode === null) {
    await new Promise((r) => setTimeout(r, 1500));
    const screen = getScreenText();
    fs.writeFileSync(path.join(EVIDENCE_DIR, "claude-tui-screen.txt"), screen, "utf8");

    // Check if workspace trust safety check is shown
    if (screen.includes("trust this folder") || screen.includes("Is this a project you created") || screen.includes("safety check")) {
      logAction("trust_workspace_dialog");
      sendInput("\x1b[B\r"); // Down arrow to "Yes, I trust this folder", then Enter
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    // Check if bypass permissions dialog is shown
    if (screen.includes("Bypass Permissions mode") || screen.includes("Yes, I accept")) {
      logAction("accept_bypass_permissions");
      sendInput("\x1b[B\r");
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    // Check if onboarding text style selection is shown
    if (screen.includes("Let's get started") || screen.includes("Choose the text style") || screen.includes("Dark mode")) {
      logAction("onboarding_confirm");
      sendInput("\r");
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    const hasDialog =
      screen.includes("trust") ||
      screen.includes("safety check") ||
      screen.includes("Bypass Permissions") ||
      screen.includes("Let's get started") ||
      screen.includes("Choose the text style");

    // Check if initial prompt box is ready and /phase-plan not sent yet
    if (!phasePlanInvoked && !hasDialog) {
      if (
        screen.includes("What would you like to do?") ||
        screen.includes("Type a prompt") ||
        screen.includes("Ask a question") ||
        screen.includes("Sonnet 4.6") ||
        screen.includes("auto mode") ||
        screen.includes("shift+tab") ||
        screen.includes("❯")
      ) {
        logAction("send_initial_prompt", { prompt: `/phase-plan ${GOAL}` });
        const text = `/phase-plan ${GOAL}`;
        for (let i = 0; i < text.length; i += 60) {
          sendInput(text.slice(i, i + 60));
          await new Promise((r) => setTimeout(r, 100));
        }
        await new Promise((r) => setTimeout(r, 600));
        sendInput("\r");
        phasePlanInvoked = true;
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
    }

    // Auto-approve permission dialogs / prompts if any appear
    if (
      screen.includes("Do you want to") ||
      screen.includes("Do you want to proceed?") ||
      screen.includes("approve") ||
      screen.includes("(Y/n)") ||
      screen.includes("[Y/n]") ||
      screen.includes("Allow once") ||
      screen.includes("Allow always")
    ) {
      logAction("auto_approve_dialog");
      sendInput("\r");
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Check if Claude asks for confirmation or continuation in text
    if (
      screen.includes("Should I proceed?") ||
      screen.includes("Ready to proceed?") ||
      screen.includes("Would you like me to proceed?")
    ) {
      logAction("confirm_continuation");
      sendInput("Yes, please proceed.\r");
      await new Promise((r) => setTimeout(r, 3000));
    }

    // Check SQLite store for execution run completion
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

          console.log(`[HEARTBEAT] Run ${run.execution_run_id} lifecycle=${run.lifecycle} stages=${stages.filter(s=>s.status==='completed').length}/${stages.length} commits=${commits.length} directives=${directives.length} reports=${reports.length}`);

          if (run.lifecycle === "completed") {
            logAction("execution_run_completed", { runId: run.execution_run_id });
            completedVerification = {
              dbPath,
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
        // Read retry on SQLite locked/busy
      }
    }
  }

  // Gracefully stop child
  try {
    child.kill();
  } catch {}

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n=== Claude Code Execution Finished in ${elapsed}s ===`);

  // Physical test in workspace
  let testPass = false;
  try {
    const testOut = execFileSync("node", ["check.js"], { cwd: WORKSPACE_DIR }).toString().trim();
    testPass = testOut.includes("validation OK");
    console.log(`[PASS] Physical check.js verification: ${testOut}`);
  } catch (err) {
    console.error(`[FAIL] Physical check.js failed: ${err.message}`);
  }

  // Check notes.txt
  const notesContent = fs.readFileSync(path.join(WORKSPACE_DIR, "notes.txt"), "utf8");
  console.log(`[PASS] notes.txt content:\n${notesContent.trim()}`);

  const evidence = {
    verifiedAt: new Date().toISOString(),
    elapsedSeconds: elapsed,
    goal: GOAL,
    physicalCheckPass: testPass,
    notesContent,
    completedVerification,
  };

  fs.writeFileSync(path.join(EVIDENCE_DIR, "claude-fullflow-evidence.json"), JSON.stringify(evidence, null, 2), "utf8");
  console.log(`Saved evidence to ${path.join(EVIDENCE_DIR, "claude-fullflow-evidence.json")}`);

  if (testPass) {
    console.log("=== CLAUDE CODE FULL-FLOW VERIFICATION: PASS ===");
    process.exit(0);
  } else {
    console.error("=== CLAUDE CODE FULL-FLOW VERIFICATION: INCOMPLETE ===");
    process.exit(1);
  }
}

runLoop().catch((err) => {
  console.error("Verification harness error:", err);
  process.exit(1);
});
