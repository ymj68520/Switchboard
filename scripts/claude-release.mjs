#!/usr/bin/env node
/**
 * Phase Plan v0.1 release build for the Claude Code adapter (Phase 18 §6).
 *
 *   npm run release:claude [-- --fast]
 *
 * Full gate sequence (§6): typecheck → lint → full adapter tests →
 * deterministic bundle build → allowlist staging → secret/path scan →
 * `claude plugin validate` (staged) → deterministic archive → digest →
 * reproducibility double-build → extracted-artifact validate + byte
 * comparison → staged-bundle MCP handshake (serverInfo version + 18 tools)
 * → `--version` smoke → marketplace materialization + validate →
 * release manifest + provenance.
 *
 * `--fast` skips typecheck/lint/tests for release-tree iteration only; it is
 * NOT a release build and the manifest records that fact.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  createDeterministicZip,
  listTree,
  resetDir,
  scanReleaseTree,
  stageReleaseTree,
} from "./claude-release-lib.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADAPTER_ROOT = path.join(REPO_ROOT, "adapters", "claude-code");
const RELEASE_ROOT = path.join(REPO_ROOT, "release");
const FAST = process.argv.includes("--fast");

const stepResults = [];
function step(name, status, detail = "") {
  stepResults.push({ name, status, detail });
  const mark = status === "PASS" ? "✓" : status === "WARN" ? "!" : "✗";
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (status === "FAIL") {
    throw new Error(`release step failed: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function run(command, args, options = {}) {
  const { cwd = REPO_ROOT, capture = false } = options;
  // On Windows we spawn through cmd; the command AND args may contain
  // spaces (e.g. nvm's "Author Software" install path), so the whole line
  // is quoted explicitly.
  const quote = (part) => (/[\s"]/.test(part) ? `"${part.split('"').join('\\"')}"` : part);
  const line = [command, ...args].map(quote).join(" ");
  return new Promise((resolve, reject) => {
    const child = spawn(line, {
      cwd,
      shell: process.platform === "win32",
      windowsHide: true,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout?.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr?.on("data", (d) => {
        stderr += d.toString();
      });
    }
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  }).then(async (result) => {
    if (result.code !== 0) {
      throw new Error(`command failed (${command} ${args.join(" ")}) exit=${result.code}\n${result.stdout.slice(-2000)}\n${result.stderr.slice(-2000)}`);
    }
    return result;
  });
}

async function readManifestVersion() {
  const manifest = JSON.parse(await fs.readFile(path.join(ADAPTER_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  if (typeof manifest.version !== "string" || manifest.version === "") {
    throw new Error("plugin manifest has no version");
  }
  if (manifest.name !== "phase-plan") {
    throw new Error(`plugin identity must stay 'phase-plan' (§56), found '${manifest.name}'`);
  }
  return manifest;
}

/** Minimal stdio MCP client: initialize + tools/list against a bundle. */
function mcpHandshake(nodeExe, bundlePath, pluginDataRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeExe, [bundlePath, "mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: pluginDataRoot,
        CLAUDE_PLUGIN_ROOT: path.dirname(path.dirname(bundlePath)),
      },
    });
    let buffer = "";
    const messages = [];
    child.stdout?.on("data", (d) => {
      buffer += d.toString();
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line !== "") {
          try {
            messages.push(JSON.parse(line));
          } catch {
            reject(new Error(`MCP stdout was not protocol-pure: ${line.slice(0, 200)}`));
            child.kill();
            return;
          }
        }
      }
    });
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    const fail = (message) => {
      child.kill();
      reject(new Error(`${message}\nstderr: ${stderr.slice(-500)}`));
    };
    const timer = setTimeout(() => fail("MCP handshake timed out"), 30000);
    child.on("exit", (code) => {
      if (!messages.some((m) => m.id === 2)) {
        clearTimeout(timer);
        reject(new Error(`MCP server exited before tools/list (code=${code})\nstderr: ${stderr.slice(-500)}`));
      }
    });
    const send = (obj) => child.stdin?.write(JSON.stringify(obj) + "\n");
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "phase-plan-release", version: "0.0.0" },
      },
    });
    // Poll for the initialize response, then complete the handshake.
    const poll = setInterval(() => {
      if (messages.some((m) => m.id === 1)) {
        clearInterval(poll);
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        const poll2 = setInterval(() => {
          const list = messages.find((m) => m.id === 2);
          if (list) {
            clearTimeout(timer);
            clearInterval(poll2);
            const init = messages.find((m) => m.id === 1);
            child.kill();
            resolve({
              serverInfo: init?.result?.serverInfo ?? null,
              tools: list.result?.tools ?? [],
            });
          }
        }, 100);
      }
    }, 100);
  });
}

async function main() {
  console.log(`Phase Plan release build${FAST ? " (--fast: typecheck/lint/tests skipped)" : ""}\n`);
  await resetDir(RELEASE_ROOT);

  // 0. Provenance preflight.
  const gitRev = (await run("git", ["rev-parse", "HEAD"], { capture: true })).stdout.trim();
  const gitStatus = (await run("git", ["status", "--porcelain"], { capture: true })).stdout.trim();
  const gitDirty = gitStatus !== "";
  if (gitDirty && !FAST) {
    step("git-clean-tree", "WARN", "working tree is dirty — release manifest records gitDirty=true (E65 measures the FINAL tree)");
  } else {
    step("git-clean-tree", "PASS", gitDirty ? "dirty (--fast iteration)" : "clean");
  }
  const manifest = await readManifestVersion();
  const version = manifest.version;
  step("manifest-identity", "PASS", `phase-plan v${version}`);

  // 1–3. Quality gates.
  let testCounts = { passed: null, skipped: null, fast: true };
  if (!FAST) {
    await run("npm", ["run", "typecheck", "--workspace", "@switchboard/claude-code"]);
    step("typecheck", "PASS");
    await run("npm", ["run", "lint", "--workspace", "@switchboard/claude-code"]);
    step("lint", "PASS");
    const test = await run("npm", ["test", "--workspace", "@switchboard/claude-code"], { capture: true });
    // Strip ANSI so the summary regexes see plain text.
    const plain = test.stdout.replace(/\x1b\[[0-9;]*m/g, "");
    const passed = /Tests\s+(\d+)\s+passed/.exec(plain)?.[1] ?? "unknown";
    const skipped = /(\d+)\s+skipped/.exec(plain)?.[1];
    step("adapter-tests", "PASS", `${passed} passed${skipped ? `, ${skipped} skipped` : ""}`);
    testCounts = { passed: Number(passed), skipped: skipped ? Number(skipped) : 0 };
  }

  // 4. Deterministic bundle build.
  await run("npm", ["run", "build", "--workspace", "@switchboard/claude-code"]);
  step("bundle-build", "PASS", "dist/phase-plan-runtime.mjs");

  // 5. Allowlist staging.
  const stagingRoot = path.join(RELEASE_ROOT, "staging");
  const pluginRoot = path.join(stagingRoot, "phase-plan");
  const staged = await stageReleaseTree(ADAPTER_ROOT, pluginRoot);
  step("allowlist-staging", "PASS", `${staged.length} files`);

  // 6. Secret + local-machine scan (§8/§54).
  const violations = await scanReleaseTree(pluginRoot, staged.map((f) => ({ relPath: f.relPath, stagedPath: f.stagedPath })));
  if (violations.length > 0) {
    step("secret-path-scan", "FAIL", `RELEASE_SECRET_LEAK: ${violations.join("; ")}`);
  }
  step("secret-path-scan", "PASS", "no secrets, no developer paths");

  // 7. claude plugin validate on the assembled tree (§53).
  const validateStaged = await run("claude", ["plugin", "validate", pluginRoot, "--json"], { capture: true });
  step("claude-plugin-validate-staged", "PASS", summarizeValidate(validateStaged.stdout));

  // 8. Deterministic archive + digest.
  const zipEntries = [];
  for (const file of await listTree(pluginRoot)) {
    zipEntries.push({ relPath: file.relPath, bytes: await fs.readFile(file.absPath) });
  }
  const zipPath = path.join(RELEASE_ROOT, `phase-plan-${version}.zip`);
  await fs.writeFile(zipPath, createDeterministicZip(zipEntries));
  const digest = createHash("sha256").update(await fs.readFile(zipPath)).digest("hex");
  step("deterministic-archive", "PASS", `phase-plan-${version}.zip sha256=${digest.slice(0, 16)}…`);

  // 9. Reproducibility double-build (E11): second independent stage+zip.
  const staging2 = path.join(RELEASE_ROOT, "staging-rebuild");
  const pluginRoot2 = path.join(staging2, "phase-plan");
  await stageReleaseTree(ADAPTER_ROOT, pluginRoot2);
  const zipEntries2 = [];
  for (const file of await listTree(pluginRoot2)) {
    zipEntries2.push({ relPath: file.relPath, bytes: await fs.readFile(file.absPath) });
  }
  const zip2 = createDeterministicZip(zipEntries2);
  const digest2 = createHash("sha256").update(zip2).digest("hex");
  if (digest2 !== digest) {
    step("reproducible-build", "FAIL", `digest mismatch ${digest} vs ${digest2}`);
  }
  step("reproducible-build", "PASS", "two builds → byte-identical archive");

  // 10. Extracted-artifact verification (§10): validate + byte comparison.
  // The archive's entries sit at the plugin-root level (no wrapping folder),
  // so the extraction directory IS the plugin root.
  const extractedRoot = path.join(RELEASE_ROOT, "extracted-verify");
  await resetDir(extractedRoot);
  await extractZip(zipPath, extractedRoot);
  const extractedFiles = await listTree(extractedRoot);
  if (extractedFiles.length !== zipEntries.length) {
    step("extracted-artifact", "FAIL", `entry count ${extractedFiles.length} != ${zipEntries.length}`);
  }
  for (const file of extractedFiles) {
    const original = zipEntries.find((e) => e.relPath === file.relPath);
    if (!original || !original.bytes.equals(await fs.readFile(file.absPath))) {
      step("extracted-artifact", "FAIL", `byte mismatch after extraction: ${file.relPath}`);
    }
  }
  const validateExtracted = await run("claude", ["plugin", "validate", extractedRoot, "--json"], { capture: true });
  step("claude-plugin-validate-extracted", "PASS", summarizeValidate(validateExtracted.stdout));

  // 11. Staged-bundle MCP handshake: serverInfo version + exactly 18 tools.
  const handshakeData = await fs.mkdtemp(path.join(os.tmpdir(), "phase-plan-release-mcp-"));
  const handshake = await mcpHandshake(process.execPath, path.join(pluginRoot, "dist", "phase-plan-runtime.mjs"), handshakeData);
  if (handshake.serverInfo?.version !== version) {
    step("mcp-handshake", "FAIL", `serverInfo.version ${handshake.serverInfo?.version} != manifest ${version}`);
  }
  if (handshake.tools.length !== 18) {
    step("mcp-handshake", "FAIL", `tools/list returned ${handshake.tools.length} tools, expected 18 (E3/E21)`);
  }
  step("mcp-handshake", "PASS", `serverInfo v${handshake.serverInfo?.version}, ${handshake.tools.length} tools`);

  // 12. --version smoke from the staged bundle (§37).
  const versionRun = await run(process.execPath, [path.join(pluginRoot, "dist", "phase-plan-runtime.mjs"), "--version"], { capture: true });
  const expectedBanner = `phase-plan ${version}`;
  if (!versionRun.stdout.includes(expectedBanner) || !versionRun.stdout.includes("schema support 13")) {
    step("version-command", "FAIL", `unexpected banner: ${versionRun.stdout.trim().slice(0, 120)}`);
  }
  step("version-command", "PASS", versionRun.stdout.trim().split("\n").join(" | "));

  // 13. Marketplace materialization (§18/§47) + validation.
  const marketplaceRoot = path.join(RELEASE_ROOT, "marketplace");
  await resetDir(marketplaceRoot);
  await fs.mkdir(path.join(marketplaceRoot, ".claude-plugin"), { recursive: true });
  await fs.cp(pluginRoot, path.join(marketplaceRoot, "phase-plan"), { recursive: true });
  const marketplaceManifest = {
    name: "phase-plan-release-test",
    owner: { name: "Switchboard" },
    metadata: {
      description: "Local release-test marketplace for the Phase Plan v0.1 plugin (Phase 18 §18/§47).",
      version,
    },
    plugins: [
      {
        name: "phase-plan",
        description: manifest.description,
        version,
        source: "./phase-plan",
      },
    ],
  };
  await fs.writeFile(
    path.join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
    JSON.stringify(marketplaceManifest, null, 2) + "\n",
  );
  const validateMarketplace = await run("claude", ["plugin", "validate", marketplaceRoot, "--json"], { capture: true });
  step("marketplace-materialize", "PASS", `phase-plan-release-test @ v${version}; ${summarizeValidate(validateMarketplace.stdout)}`);

  // 14. Digest sidecar + release manifest (§38/§62/§63).
  await fs.writeFile(path.join(RELEASE_ROOT, `phase-plan-${version}.zip.sha256`), `${digest}  phase-plan-${version}.zip\n`);
  const claudeVersion = await probeClaudeHostVersion();
  const releaseMetadata = {
    product: "phase-plan",
    version,
    schemaVersion: 13,
    toolCount: handshake.tools.length,
    toolNames: handshake.tools.map((t) => t.name),
    runtime: { node: ">=24.15.0" },
    artifact: `phase-plan-${version}.zip`,
    artifactSha256: digest,
    reproducibleBuild: true,
    gitCommit: gitRev,
    gitDirty,
    validatedClaudeHost: claudeVersion,
    testCounts,
    buildEnvironment: {
      node: process.version,
      platform: `${os.platform()} ${os.arch()}`,
      release: os.release(),
    },
    builtAt: new Date().toISOString(),
    fastBuild: FAST,
  };
  await fs.writeFile(
    path.join(RELEASE_ROOT, `phase-plan-${version}-release.json`),
    JSON.stringify(releaseMetadata, null, 2) + "\n",
  );
  step("release-metadata", "PASS", `phase-plan-${version}-release.json`);

  console.log(`\nRELEASE ARTIFACT READY: release/phase-plan-${version}.zip`);
  console.log(`SHA-256: ${digest}`);
}

function summarizeValidate(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return "validate OK (non-JSON output)";
  }
  const manifest = parsed.manifest ?? {};
  const notes = (manifest.errors?.length ?? 0) + (manifest.warnings?.length ?? 0) + (manifest.notes?.length ?? 0);
  if (parsed.success === false) {
    throw new Error(`claude plugin validate FAILED: ${(manifest.errors ?? []).join("; ") || JSON.stringify(parsed).slice(0, 200)}`);
  }
  return `validate OK${notes ? ` (${notes} notes to classify)` : ""}`;
}

async function probeClaudeHostVersion() {
  try {
    const result = await run("claude", ["--version"], { capture: true });
    const match = /([0-9]+\.[0-9]+\.[0-9]+)\s+\(Claude Code\)/.exec(result.stdout);
    return match?.[1] ?? result.stdout.trim().slice(0, 40);
  } catch {
    return "unknown";
  }
}

/** Extract a zip via PowerShell (Windows) or bsdtar/tar elsewhere. */
async function extractZip(zipPath, outDir) {
  if (process.platform === "win32") {
    const psPath = zipPath.split("\\").join("\\\\");
    const psOut = outDir.split("\\").join("\\\\");
    await run(
      "powershell",
      ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${psPath}' -DestinationPath '${psOut}' -Force`],
      { capture: true },
    );
    return;
  }
  await run("tar", ["-xf", zipPath, "-C", outDir], { capture: true });
}

main().catch((err) => {
  console.error(`\nRELEASE BUILD FAILED: ${err.message}`);
  process.exitCode = 1;
});
