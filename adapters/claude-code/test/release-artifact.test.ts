/**
 * Release artifact mechanics (Phase 18 §7/§8/§9/§54): allowlist staging,
 * secret/local-path scanning, and byte-deterministic archiving, exercised
 * directly against the release library the `npm run release:claude` script
 * uses.
 */

import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  RELEASE_ALLOWLIST,
  createDeterministicZip,
  scanReleaseTree,
  stageReleaseTree,
} from "../../../scripts/claude-release-lib.mjs";

const releaseLibUrl = pathToFileURL(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "claude-release-lib.mjs"),
);
const ADAPTER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const tempRoots: string[] = [];
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of tempRoots) {
    // Windows test runners can hold brief locks on freshly written files.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("release tree staging (§7)", () => {
  it("stages exactly the allowlist from the real adapter tree", async () => {
    const out = await makeTempDir("phase-plan-stage-");
    const staged = await stageReleaseTree(ADAPTER_ROOT, out);
    expect(staged.map((f) => f.relPath)).toEqual([...RELEASE_ALLOWLIST].sort());
    // Nothing beyond the allowlist ever enters the tree.
    const listing: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(abs);
        else listing.push(path.relative(out, abs).split("\\").join("/"));
      }
    }
    await walk(out);
    expect(new Set(listing)).toEqual(new Set(RELEASE_ALLOWLIST));
  });

  it("fails loudly when an allowlisted input is missing", async () => {
    const fakeRoot = await makeTempDir("phase-plan-fake-adapter-");
    await expect(stageReleaseTree(fakeRoot, await makeTempDir("phase-plan-stage2-"))).rejects.toThrow(/allowlist entry missing/);
  });
});

describe("secret and local-machine path scan (§8/§54)", () => {
  async function scanFiles(files: Record<string, string>) {
    const root = await makeTempDir("phase-plan-scan-");
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, ...rel.split("/"));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    }
    return scanReleaseTree(root);
  }

  it("flags credentials, keys, and tokens", async () => {
    const violations = await scanFiles({
      "dist/x.mjs": 'const t = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA";\n',
    });
    expect(violations.some((v) => v.includes("Anthropic API token"))).toBe(true);
  });

  it("flags developer-machine paths and harness assumptions", async () => {
    const violations = await scanFiles({
      "README.md": "run it from C:\\Users\\Administrator\\... or D:/Programing/agent",
      "dist/y.mjs": "const env = process.env.MSYS_NO_PATHCONV;\n",
    });
    expect(violations.length).toBeGreaterThanOrEqual(3);
    expect(violations.some((v) => v.includes("Windows user profile path"))).toBe(true);
    expect(violations.some((v) => v.includes("developer checkout path"))).toBe(true);
    expect(violations.some((v) => v.includes("Git Bash harness assumption"))).toBe(true);
  });

  it("forbids store/secret/debug artifacts by file name", async () => {
    const violations = await scanFiles({
      "store/phase-plan.sqlite3": "junk",
      "runtime/host-context.key": "00ff",
      "capability-proofs.json": "{}",
      "debug.log": "log line",
    });
    expect(violations.length).toBe(4);
    expect(violations.every((v) => v.startsWith("FORBIDDEN FILE NAME"))).toBe(true);
  });

  it("does not misflag abstract example paths (§8)", async () => {
    const violations = await scanFiles({
      "README.md": "All state lives under ${CLAUDE_PLUGIN_DATA}; the plugin root is ${CLAUDE_PLUGIN_ROOT}.\n",
      "docs.md": "Use forward slashes such as <plugin-root>/dist/runtime.mjs in documentation examples.\n",
    });
    expect(violations).toEqual([]);
  });
});

describe("deterministic archive (§9)", () => {
  it("is byte-identical across builds and input orders", async () => {
    const entry = { relPath: "dist/runtime.mjs", bytes: Buffer.from("const x = 1;\n".repeat(500)) };
    const small = { relPath: "README.md", bytes: Buffer.from("# Phase Plan\n") };
    const a = createDeterministicZip([entry, small]);
    const b = createDeterministicZip([small, entry]);
    expect(a.equals(b)).toBe(true);
  });

  it("round-trips byte-identical content through a real extractor", async () => {
    const files = [
      { relPath: ".claude-plugin/plugin.json", bytes: Buffer.from('{"name":"phase-plan"}') },
      { relPath: "dist/runtime.mjs", bytes: Buffer.from("// bundle\n".repeat(1000)) },
      { relPath: "hooks/hooks.json", bytes: Buffer.from('{"hooks":{}}') },
    ];
    const zip = createDeterministicZip(files);
    const outDir = await makeTempDir("phase-plan-zip-");
    await fs.writeFile(path.join(outDir, "artifact.zip"), zip);
    const extraction = spawnSync(process.platform === "win32" ? String.raw`C:\Windows\System32\tar.exe` : "tar", ["-xf", "artifact.zip"], {
      cwd: outDir,
      encoding: "utf8",
    });
    expect(extraction.status).toBe(0);
    for (const file of files) {
      const extracted = await fs.readFile(path.join(outDir, ...file.relPath.split("/")));
      expect(extracted.equals(file.bytes), file.relPath).toBe(true);
    }
  });
});

describe("release library consumes the real allowlist", () => {
  it("pins the frozen §2 artifact shape", async () => {
    const lib = await import(releaseLibUrl.href);
    expect(lib.RELEASE_ALLOWLIST).toEqual([
      ".claude-plugin/plugin.json",
      ".mcp.json",
      "hooks/hooks.json",
      "skills/phase-plan/SKILL.md",
      "agents/validator.md",
      "dist/phase-plan-runtime.mjs",
      "README.md",
      "CHANGELOG.md",
    ]);
    // The manifest itself stays readable JSON with the frozen identity.
    const manifest = JSON.parse(readFileSync(path.join(ADAPTER_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
    expect(manifest.name).toBe("phase-plan");
  });
});
