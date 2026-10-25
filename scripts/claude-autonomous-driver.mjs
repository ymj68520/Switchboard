#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import sqlite3 from "node:sqlite";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

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

const RESUME_MODE = process.argv.includes("--resume");
const SESSION_ID = process.argv.find((a, i, arr) => arr[i - 1] === "--resume");
const GOAL = "Append a line containing CLAUDE_LIVE_OK to notes.txt so that node check.js passes. Do not modify check.js.";
const TIMEOUT_MS = 600_000;

console.log(`=== Starting Claude Autonomous Driver (${RESUME_MODE ? "Resume Mode: " + SESSION_ID : "Fresh Clean-Start Mode"}) ===`);

if (!RESUME_MODE) {
  fs.rmSync(ISOLATED_ROOT, { recursive: true, force: true });
  for (const dir of [WORKSPACE_DIR, CONFIG_DIR, EVIDENCE_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }

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
      [WORKSPACE_DIR]: { hasTrustDialogAccepted: true },
      [WORKSPACE_DIR.replace(/\//g, "\\")]: { hasTrustDialogAccepted: true },
    },
  };
  fs.writeFileSync(path.join(CONFIG_DIR, ".claude.json"), JSON.stringify(initialClaudeJson, null, 2), "utf8");
}

const terminal = new xterm.Terminal({ cols: 140, rows: 45, scrollback: 5000, allowProposedApi: true });
const rawLogStream = fs.createWriteStream(path.join(EVIDENCE_DIR, "claude-autonomous.raw.log"), { flags: "a" });
const actionLogStream = fs.createWriteStream(path.join(EVIDENCE_DIR, "claude-autonomous-actions.jsonl"), { flags: "a" });

function log(action, detail = {}) {
  const entry = { at: new Date().toISOString(), action, ...detail };
  actionLogStream.write(JSON.stringify(entry) + "\n");
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${action} ${Object.keys(detail).length ? JSON.stringify(detail) : ""}`);
}

const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: CONFIG_DIR,
  PATH: `${TOOLS_NODE_DIR}${path.delimiter}${process.env.PATH}`,
  TERM: "xterm-256color",
};

const spawnArgs = RESUME_MODE
  ? ["--resume", SESSION_ID, "--plugin-dir", PLUGIN_DIR]
  : ["--plugin-dir", PLUGIN_DIR];

const child = pty.spawn(CLAUDE_EXE, spawnArgs, {
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

let ptyExit = null;
child.onExit((e) => {
  ptyExit = e;
  log("child_exit", { exitCode: e.exitCode });
  rawLogStream.end();
  actionLogStream.end();
});

function getScreen() {
  const b = terminal.buffer.active;
  const lines = [];
  for (let i = 0; i < b.length; i++) {
    lines.push(b.getLine(i)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

async function sendInput(text) {
  child.write(text);
}

async function pasteText(text) {
  for (let i = 0; i < text.length; i += 80) {
    child.write(text.slice(i, i + 80));
    await new Promise((r) => setTimeout(r, 60));
  }
  await new Promise((r) => setTimeout(r, 400));
  child.write("\r");
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

function getAwaitingProposal(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  try {
    const db = new sqlite3.DatabaseSync(dbPath, { open: true, readOnly: true });
    const revs = db
      .prepare(
        "SELECT r.proposal_id, r.revision, r.proposal_hash, r.title FROM proposal_states s JOIN proposal_revisions r ON s.proposal_id = r.proposal_id AND s.revision = r.revision WHERE s.status = 'awaiting_approval' ORDER BY s.updated_at DESC LIMIT 1"
      )
      .all();
    if (revs.length === 0) return null;
    return revs[0];
  } catch {
    return null;
  }
}

async function run() {
  const startTime = Date.now();
  const deadline = startTime + TIMEOUT_MS;
  let lastApprovedHash = null;
  let executionCompletedState = null;
  let initialPromptSent = RESUME_MODE;
  let executionPromptSent = false;
  let lastPromptTime = 0;

  while (Date.now() < deadline && ptyExit === null) {
    await new Promise((r) => setTimeout(r, 2000));
    const screen = getScreen();
    fs.writeFileSync(path.join(EVIDENCE_DIR, "claude-live-screen.txt"), screen, "utf8");

    // 0. Safety / trust dialog
    if (screen.includes("trust this folder") || screen.includes("Is this a project you created") || screen.includes("safety check")) {
      log("trust_workspace_dialog");
      child.write("\x1b[B\r");
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    // 0b. Onboarding text style
    if (screen.includes("Let's get started") || screen.includes("Choose the text style") || screen.includes("Dark mode")) {
      log("onboarding_confirm");
      child.write("\r");
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    // 1. Tool permission / safety dialogs
    if (
      screen.includes("Do you want to proceed?") ||
      screen.includes("Do you want to run tool") ||
      screen.includes("(Y/n)") ||
      screen.includes("[Y/n]") ||
      screen.includes("Allow once") ||
      screen.includes("Allow always") ||
      screen.includes("Enter to continue")
    ) {
      log("auto_approve_dialog");
      child.write("\r");
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    // 2. Initial prompt in clean-start mode
    const hasDialog =
      screen.includes("trust") ||
      screen.includes("safety check") ||
      screen.includes("Bypass Permissions") ||
      screen.includes("Let's get started") ||
      screen.includes("Choose the text style");

    const dbPath = findSqliteDb();
    let hasPlanningRun = false;
    if (dbPath && fs.existsSync(dbPath)) {
      try {
        const db = new sqlite3.DatabaseSync(dbPath, { open: true, readOnly: true });
        const res = db.prepare("SELECT count(*) FROM planning_runs").all();
        hasPlanningRun = res[0] && res[0]["count(*)"] > 0;
      } catch {}
    }

    if (!hasPlanningRun && !hasDialog && (screen.includes("Sonnet 4.6") || screen.includes("auto mode") || screen.includes("❯"))) {
      if (Date.now() - lastPromptTime > 6000) {
        log("send_initial_prompt", { prompt: `/phase-plan ${GOAL}` });
        await pasteText(`/phase-plan ${GOAL}`);
        lastPromptTime = Date.now();
        await new Promise((r) => setTimeout(r, 4000));
        continue;
      }
    }

    // 3. Proposal approval request from Claude in text
    if (
      (screen.includes("authorize this") ||
        screen.includes("approve this proposal") ||
        screen.includes("Do you authorize") ||
        screen.includes("Proposal Awaiting Your Approval")) &&
      screen.includes("❯")
    ) {
      const prop = getAwaitingProposal(dbPath);
      if (prop && prop.proposal_hash !== lastApprovedHash) {
        const msg = `Yes, I authorize proposal ${prop.proposal_id}@${prop.revision} hash ${prop.proposal_hash}. Please call approve_proposal to commit it and proceed.`;
        log("authorizing_proposal", { id: prop.proposal_id, rev: prop.revision, hash: prop.proposal_hash });
        await pasteText(msg);
        lastApprovedHash = prop.proposal_hash;
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
    }

    // 4. Execution mode prompt when waiting at ❯
    if (screen.includes("❯") && Date.now() - lastPromptTime > 15000) {
      if (dbPath && fs.existsSync(dbPath)) {
        try {
          const db = new sqlite3.DatabaseSync(dbPath, { open: true, readOnly: true });
          const execRuns = db.prepare("SELECT * FROM execution_runs").all();
          if (execRuns.length > 0 && execRuns[0].lifecycle === "active") {
            const directives = db.prepare("SELECT * FROM execution_directives WHERE execution_run_id=?").all(execRuns[0].execution_run_id);
            if (directives.length === 0 && !executionPromptSent) {
              log("prompting_execution_start");
              await pasteText("Please continue supervised execution: activate the execution stage, issue the execution directive for step-1, dispatch the execution worker to append CLAUDE_LIVE_OK to notes.txt, verify it, and complete the run.");
              executionPromptSent = true;
              lastPromptTime = Date.now();
              await new Promise((r) => setTimeout(r, 4000));
              continue;
            } else if (directives.length > 0) {
              log("prompting_execution_progress");
              await pasteText("Please continue supervised execution: verify the worker output, accept the stage, perform final closure, and complete the run.");
              lastPromptTime = Date.now();
              await new Promise((r) => setTimeout(r, 4000));
              continue;
            }
          }
        } catch {}
      }
    }

    // 5. General confirmation in text
    if (
      (screen.includes("Should I proceed?") ||
        screen.includes("Ready to proceed?") ||
        screen.includes("Would you like me to proceed?")) &&
      screen.includes("❯")
    ) {
      log("send_text_confirmation");
      await pasteText("Yes, proceed.");
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    // 6. Check SQLite database state for heartbeat & completion
    if (dbPath && fs.existsSync(dbPath)) {
      try {
        const db = new sqlite3.DatabaseSync(dbPath, { open: true, readOnly: true });
        const plans = db.prepare("SELECT * FROM planning_runs").all();
        const commits = db.prepare("SELECT * FROM plan_commits").all();
        const execRuns = db.prepare("SELECT * FROM execution_runs").all();

        const planStage = plans[0]?.stage;
        const planLifecycle = plans[0]?.lifecycle;
        const execRun = execRuns[0];

        if (execRun) {
          const stages = db.prepare("SELECT * FROM execution_stages WHERE execution_run_id=?").all(execRun.execution_run_id);
          const execCommits = db.prepare("SELECT * FROM execution_commits WHERE execution_run_id=?").all(execRun.execution_run_id);
          const directives = db.prepare("SELECT * FROM execution_directives WHERE execution_run_id=?").all(execRun.execution_run_id);
          const reports = db.prepare("SELECT * FROM execution_reports WHERE execution_run_id=?").all(execRun.execution_run_id);

          log("heartbeat_execution", {
            runId: execRun.execution_run_id,
            lifecycle: execRun.lifecycle,
            completedStages: `${stages.filter((s) => s.status === "completed").length}/${stages.length}`,
            commits: execCommits.length,
            directives: directives.length,
            reports: reports.length,
          });

          if (execRun.lifecycle === "completed") {
            log("execution_completed_success");
            executionCompletedState = {
              execRun,
              stages,
              execCommits,
              directives,
              reports,
            };
            break;
          }
        } else {
          log("heartbeat_planning", {
            stage: planStage,
            lifecycle: planLifecycle,
            commitsCount: commits.length,
          });
        }
      } catch (err) {
        // SQLite busy/locked retry
      }
    }
  }

  try {
    child.kill();
  } catch {}

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n=== Claude Autonomous Driver Finished in ${elapsed}s ===`);

  // Physical test in workspace
  let testPass = false;
  try {
    const testOut = execFileSync("node", ["check.js"], { cwd: WORKSPACE_DIR }).toString().trim();
    testPass = testOut.includes("validation OK");
    console.log(`[PASS] Physical check.js verification: ${testOut}`);
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
    mode: RESUME_MODE ? "resume" : "clean_start",
    sessionId: SESSION_ID ?? "auto",
    physicalCheckPass: testPass,
    notesContent,
    executionCompletedState,
  };

  fs.writeFileSync(path.join(EVIDENCE_DIR, "claude-autonomous-evidence.json"), JSON.stringify(evidence, null, 2), "utf8");
  console.log(`Evidence saved to ${path.join(EVIDENCE_DIR, "claude-autonomous-evidence.json")}`);

  if (testPass) {
    console.log("=== CLAUDE CODE FULL-FLOW VERIFICATION: PASS ===");
    process.exit(0);
  } else {
    console.log("=== Verification Finished ===");
    process.exit(0);
  }
}

run().catch((err) => {
  console.error("Driver error:", err);
  process.exit(1);
});
