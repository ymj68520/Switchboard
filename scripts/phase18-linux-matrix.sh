#!/usr/bin/env bash
# Phase 18 §30 — Linux runtime matrix (WSL Ubuntu 24.04, native Node 24).
set -e
export PATH="$HOME/phase18-node/bin:$PATH"
echo "node: $(node --version) @ $(which node)"

echo "=== artifact extraction + verification ==="
mkdir -p "$HOME/phase18-artifact" && cd "$HOME/phase18-artifact"
cp /mnt/d/Programing/agent/plan-plugin/release/phase-plan-0.1.1.zip .
rm -rf extracted && mkdir extracted
python3 -m zipfile -e phase-plan-0.1.1.zip extracted/
find extracted -type f | sort
echo "bundle sha256 (first 20): $(sha256sum extracted/dist/phase-plan-runtime.mjs | cut -c1-20)"

echo "=== --version ==="
node extracted/dist/phase-plan-runtime.mjs --version

echo "=== doctor (fresh plugin data, POSIX paths) ==="
export CLAUDE_PLUGIN_DATA="$HOME/phase18-plugin-data"
rm -rf "$CLAUDE_PLUGIN_DATA"
node extracted/dist/phase-plan-runtime.mjs doctor | grep -E "^\s+(node|node:sqlite|plugin data|Plan Store)|Overall"

echo "=== cold MCP initialize + tools/list (stdout protocol purity) ==="
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"p18linux","version":"0.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node extracted/dist/phase-plan-runtime.mjs mcp 2>/dev/null | node -e '
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const lines = s.trim().split("\n").map((l) => JSON.parse(l));
  const init = lines.find((m) => m.id === 1);
  const tools = lines.find((m) => m.id === 2);
  console.log("serverInfo:", JSON.stringify(init.result.serverInfo));
  console.log("tool count:", tools.result.tools.length);
});'

echo "=== store init/reopen + backup + sqlite version ==="
node -e '
const { DatabaseSync, backup } = require("node:sqlite");
const fs = require("node:fs");
const dbPath = process.env.CLAUDE_PLUGIN_DATA + "/store/phase-plan.sqlite3";
console.log("store exists after cold start:", fs.existsSync(dbPath));
const db = new DatabaseSync(dbPath, { readOnly: true });
console.log("schema:", db.prepare("PRAGMA user_version").get().user_version);
console.log("sqlite_version:", db.prepare("select sqlite_version() v").get().v);
console.log("integrity:", db.prepare("PRAGMA integrity_check").get().integrity_check);
db.close();
const src = new DatabaseSync(dbPath);
backup(src, dbPath + ".bak").then(() => {
  console.log("backup written:", fs.existsSync(dbPath + ".bak"));
  src.close();
});'

echo "=== host-context.key permissions (0600 on POSIX) ==="
stat -c "%a %n" "$CLAUDE_PLUGIN_DATA/runtime/host-context.key"

echo "=== warm start: reopen store, second MCP boot ==="
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"p18linux2","version":"0.0.0"}}}' \
  | node extracted/dist/phase-plan-runtime.mjs mcp 2>/dev/null | head -1 | cut -c1-80
echo "LINUX_MATRIX_DONE"
