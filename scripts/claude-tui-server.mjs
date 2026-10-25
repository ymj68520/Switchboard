#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
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
const PORT = 19327;

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

// 3. Write Settings & Config
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

// 4. Setup PTY & Terminal
const terminal = new xterm.Terminal({ cols: 140, rows: 45, scrollback: 5000, allowProposedApi: true });
const rawLogStream = fs.createWriteStream(path.join(EVIDENCE_DIR, "claude-tui.raw.log"), { flags: "a" });
const actionLogStream = fs.createWriteStream(path.join(EVIDENCE_DIR, "claude-actions.jsonl"), { flags: "a" });

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

let exited = null;
child.onExit((e) => {
  exited = e;
  rawLogStream.end();
  actionLogStream.end();
});

// 5. HTTP Control Server
const server = http.createServer((req, res) => {
  if (req.method === "POST") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        const action = JSON.parse(body);
        if (action.stop) {
          child.kill();
          server.close();
        } else if (action.input !== undefined) {
          child.write(action.input);
        }
        actionLogStream.write(JSON.stringify({ at: new Date().toISOString(), ...action }) + "\n");
        res.end("ok");
      } catch (err) {
        res.statusCode = 400;
        res.end(err.message);
      }
    });
  } else {
    const b = terminal.buffer.active;
    const lines = [];
    for (let i = 0; i < b.length; i++) {
      lines.push(b.getLine(i)?.translateToString(true) ?? "");
    }
    const snapshot = JSON.stringify({ exited, screen: lines.join("\n") }, null, 2);
    fs.writeFileSync(path.join(EVIDENCE_DIR, "claude-tui-screen.json"), snapshot);
    res.setHeader("Content-Type", "application/json");
    res.end(snapshot);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Claude TUI Server listening on http://127.0.0.1:${PORT}`);
});
