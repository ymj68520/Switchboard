#!/usr/bin/env node
/**
 * Canonical-artifact verification smoke (Phase 18 CI verify jobs, §33/§34).
 *
 * Given the EXTRACTED release tree, this script re-proves the runtime
 * facts on the verifying platform without rebuilding anything:
 *   1. --version banner matches the manifest version and schema floor
 *   2. doctor runs on a fresh plugin-data root (fresh-install semantics)
 *   3. an MCP initialize + tools/list handshake answers with the manifest
 *      version and exactly 18 tools, on protocol-pure stdout
 *
 * Usage: node scripts/claude-release-verify.mjs <extracted-plugin-root>
 */

import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";

const pluginRoot = process.argv[2];
if (!pluginRoot) {
  console.error("usage: node scripts/claude-release-verify.mjs <extracted-plugin-root>");
  process.exitCode = 1;
  process.exit(process.exitCode ?? 1);
}

const manifest = JSON.parse(readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
const bundle = path.join(pluginRoot, "dist", "phase-plan-runtime.mjs");
const nodeExe = process.execPath;

function run(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeExe, args, {
      windowsHide: true,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  }).then((r) => {
    if (r.code !== 0 && !options.allowNonzero) {
      throw new Error(`command failed: ${args.join(" ")}\n${r.stderr.slice(-400)}`);
    }
    return r;
  });
}

function fail(message) {
  console.error(`VERIFY FAILED: ${message}`);
  process.exitCode = 1;
  process.exit(1);
}

// 1. version banner
const versionRun = await run([bundle, "--version"]);
const banner = versionRun.stdout.trim().split("\n");
if (banner[0] !== `phase-plan ${manifest.version}`) fail(`banner mismatch: ${banner[0]}`);
if (banner[1] !== "schema support 13") fail(`schema line mismatch: ${banner[1]}`);
console.log(`[✓] --version: ${banner.join(" | ")}`);

// 2. doctor on a fresh plugin-data root (fresh-install semantics, §43).
// The doctor may exit nonzero when the host lacks a claude CLI (a required
// host check) — the JSON report is the assertion target, not the exit code.
const freshData = mkdtempSync(path.join(os.tmpdir(), "phase-plan-verify-"));
const doctorRun = await run([bundle, "doctor", "--json"], { env: { CLAUDE_PLUGIN_DATA: freshData }, allowNonzero: true });
const report = JSON.parse(doctorRun.stdout);
if (report.checks.node.status !== "PASS") fail(`node check: ${report.checks.node.message}`);
if (report.checks.sqlite.status !== "PASS") fail(`sqlite check: ${report.checks.sqlite.message}`);
if (report.checks.planStore.status !== "NOT_INITIALIZED") fail(`fresh store: ${report.checks.planStore.message}`);
console.log(`[✓] doctor: node+sqlite PASS, fresh store NOT_INITIALIZED`);

// 3. MCP handshake with exactly 18 tools and manifest version
const child = spawn(nodeExe, [bundle, "mcp"], {
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, CLAUDE_PLUGIN_DATA: mkdtempSync(path.join(os.tmpdir(), "phase-plan-verify-mcp-")) },
});
let buffer = "";
const messages = [];
child.stdout.on("data", (d) => {
  buffer += d.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) messages.push(JSON.parse(line));
  }
});
child.stderr.on("data", () => {});
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "0.0.0" } } }) + "\n");
await new Promise((r) => setTimeout(r, 1500));
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
await new Promise((r) => setTimeout(r, 2500));
child.kill();

const init = messages.find((m) => m.id === 1);
const tools = messages.find((m) => m.id === 2);
if (!init || !tools) fail("MCP handshake incomplete");
if (init.result.serverInfo.version !== manifest.version) fail(`serverInfo ${init.result.serverInfo.version} != manifest ${manifest.version}`);
if (tools.result.tools.length !== 18) fail(`tools/list returned ${tools.result.tools.length}, expected 18`);
console.log(`[✓] mcp: serverInfo v${init.result.serverInfo.version}, ${tools.result.tools.length} tools`);

console.log("VERIFY_OK");
