#!/usr/bin/env node
/**
 * Phase 2B2 §4 — Durable Backend Selection Gate.
 *
 * Boots a REAL OpenCode server with a probe plugin that runs inside the host
 * process and exercises `node:sqlite` (open file DB → create schema → BEGIN
 * IMMEDIATE → write → COMMIT → close → reopen → read), writing the result to
 * a marker file the parent reads. Proves or disproves the SQLite path inside
 * the actual OpenCode runtime before any store is built on it.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 21000 + Math.floor(Math.random() * 20000);

const PROBE = [
  'import { writeFileSync } from "node:fs";',
  'const result = { host: "opencode-serve" };',
  "try {",
  '  const { DatabaseSync } = await import("node:sqlite");',
  '  const db = new DatabaseSync(process.env.GATE_DB);',
  '  result.journalMode = db.prepare("PRAGMA journal_mode = WAL").get();',
  '  db.exec("CREATE TABLE IF NOT EXISTS gate (k TEXT PRIMARY KEY, v TEXT)");',
  '  db.exec("BEGIN IMMEDIATE");',
  '  db.prepare("INSERT OR REPLACE INTO gate (k, v) VALUES (\'probe\', ?)").run("ok-" + Date.now());',
  '  db.exec("COMMIT");',
  '  const version = db.prepare("SELECT sqlite_version() AS v").get();',
  "  db.close();",
  '  const db2 = new DatabaseSync(process.env.GATE_DB);',
  "  const row = db2.prepare(\"SELECT v FROM gate WHERE k = 'probe'\").get();",
  '  result.sqliteVersion = version?.v;',
  '  result.reopenRead = row?.v?.startsWith("ok-") ? "pass" : "mismatch";',
  "  db2.close();",
  '  result.nodeSqlite = "pass";',
  "} catch (error) {",
  '  result.nodeSqlite = "fail: " + String(error);',
  "}",
  "try {",
  '  const { Database } = await import("bun:sqlite");',
  '  const db = new Database(":memory:");',
  '  db.query("select 1").get();',
  '  result.bunSqlite = "present (Bun-only API; no Node 22 equivalent for the test environment)";',
  "} catch (error) {",
  '  result.bunSqlite = "fail: " + String(error);',
  "}",
  "try {",
  '  const { renameSync, writeFileSync, readFileSync, unlinkSync, fsyncSync, openSync, closeSync } = await import("node:fs");',
  '  const tmp = process.env.GATE_DB + ".tmp";',
  '  writeFileSync(tmp, "v2");',
  '  const fd = openSync(tmp, "r+");',
  "  fsyncSync(fd);",
  "  closeSync(fd);",
  '  renameSync(tmp, process.env.GATE_DB + ".doc");',
  '  writeFileSync(tmp, "v3");',
  '  renameSync(tmp, process.env.GATE_DB + ".doc");',
  '  result.fsAtomicRename = readFileSync(process.env.GATE_DB + ".doc", "utf8") === "v3" ? "pass" : "mismatch";',
  '  unlinkSync(tmp);',
  "} catch (error) {",
  '  result.fsAtomicRename = "fail: " + String(error);',
  "}",
  "writeFileSync(process.env.GATE_MARKER, JSON.stringify(result, null, 2));",
].join("\n");

async function main() {
  const fixture = await mkdtemp(path.join(tmpdir(), "ultraplan-gate-"));
  await mkdir(path.join(fixture, ".opencode", "plugin"), { recursive: true });
  const dbPath = path.join(fixture, "gate.db");
  const marker = path.join(fixture, "gate-result.json");
  await writeFile(path.join(fixture, ".opencode", "plugin", "gate-probe.js"), PROBE);
  await writeFile(
    path.join(fixture, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", share: "disabled" }),
  );

  const server = spawn("opencode", ["serve", "--port", String(PORT), "--hostname", "127.0.0.1"], {
    cwd: fixture,
    shell: true,
    env: { ...process.env, GATE_DB: dbPath, GATE_MARKER: marker },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  server.stdout.on("data", (d) => log.push(String(d)));
  server.stderr.on("data", (d) => log.push(String(d)));

  let result = null;
  // Poke the server first: plugins load lazily on the first request.
  for (let i = 0; i < 15; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const config = await (await fetch(`http://127.0.0.1:${PORT}/config`)).json();
      if (i === 0) console.log("server /config reachable, plugins loaded");
      void config;
      break;
    } catch {
      /* server not ready */
    }
  }
  for (let i = 0; i < 30 && !result; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      result = JSON.parse(await readFile(marker, "utf8"));
    } catch {
      /* marker not written yet */
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 500));

  console.log("=== Durable backend gate result (inside real OpenCode host) ===");
  console.log(result ? JSON.stringify(result, null, 2) : "NO RESULT — marker never written");
  console.log("--- server log tail ---");
  console.log(
    log
      .join("")
      .split("\n")
      .filter((line) => /plugin|gate|error|sqlite|serve|listen/i.test(line))
      .slice(-20)
      .join("\n"),
  );

  if (process.platform === "win32") {
    const kill = spawn("taskkill", ["/PID", String(server.pid), "/T", "/F"], { shell: true });
    kill.on("exit", () => process.exit(result?.nodeSqlite === "pass" ? 0 : 1));
  } else {
    server.kill("SIGKILL");
    process.exit(result?.nodeSqlite === "pass" ? 0 : 1);
  }
  await rm(fixture, { recursive: true, force: true }).catch(() => {});
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
