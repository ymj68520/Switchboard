import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Packaging regression pins (Phase 6 §5-§8, §26-§28, §34-§35, §39).
 *
 * These guard the production artifact boundary against quiet drift: the
 * package must stay a zero-runtime-dependency, pre-0.1, allowlisted
 * artifact whose bin runs from dist alone. The dry-run/clean-install
 * behavior itself is exercised by scripts (npm pack + temp install), not
 * by vitest — these tests pin the DECLARATIONS that make it true.
 */

const ADAPTER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(ADAPTER_ROOT, "package.json"), "utf8")) as {
  name: string;
  version: string;
  private: boolean;
  bin: Record<string, string>;
  files: string[];
  engines: { node: string };
  license: string;
  repository?: { url?: string };
  description?: string;
  dependencies?: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
};

describe("package metadata (Phase 6)", () => {
  it("stays pre-0.1: the first distributable version is 0.0.1 (§3, P6-E1)", () => {
    expect(pkg.version).toBe("0.0.1");
  });

  it("has ZERO runtime dependencies (P6-E6/E7)", () => {
    expect(pkg.dependencies).toBeUndefined();
  });

  it("keeps test/build tooling out of runtime dependencies even by accident (P6-E7)", () => {
    const devOnly = ["ws", "node-pty", "vitest", "eslint", "typescript", "typescript-eslint"];
    for (const name of devOnly) {
      expect(pkg.devDependencies?.[name] !== undefined || name === "node-pty").toBe(true);
      // node-pty is intentionally ABSENT everywhere: E2E-only, resolved via
      // NODE_PATH at probe time (P6-E6).
      if (name === "node-pty") {
        expect(pkg.devDependencies[name]).toBeUndefined();
      }
    }
  });

  it("declares the Node floor implied by real API usage (P6-E8)", () => {
    // Global WebSocket client unflagged since 22.4.0 — the binding floor.
    expect(pkg.engines.node).toBe(">=22.4.0");
  });

  it("ships only the production allowlist (P6-E4/E5)", () => {
    expect([...pkg.files].sort()).toEqual(["bin", "dist", "docs"]);
    expect(pkg.bin).toEqual({ "phase-model": "./bin/phase-model.js" });
  });

  it("has complete metadata (P6-E47)", () => {
    expect(pkg.name).toBe("@switchboard/codex");
    expect(pkg.private).toBe(true); // no accidental publish (§40)
    expect(pkg.license).toBe("UNLICENSED"); // repo has no license file
    expect(pkg.repository?.url).toContain("github.com/ymj68520/Switchboard");
    expect(typeof pkg.description).toBe("string");
  });

  it("exposes live probes as explicit opt-in only (P6-E43/E44)", () => {
    expect(pkg.scripts.test).toBe("vitest run");
    expect(pkg.scripts["test:live"]).toContain("codex-live-smoke");
    expect(pkg.scripts["test:live"]).toContain("codex-managed-tui-smoke");
  });
});

describe("production artifact boundary (Phase 6)", () => {
  it("bin entry runs from dist, never from TypeScript sources (P6-E3)", () => {
    const bin = readFileSync(path.join(ADAPTER_ROOT, "bin", "phase-model.js"), "utf8");
    expect(bin.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(bin).toContain('../dist/launcher/cli.js');
    expect(bin).not.toMatch(/\b(ts-node|tsx|vitest)\b/);
    expect(bin).not.toContain("../src/");
  });

  it("production sources reference no PTY/test tooling (P6-E6/§35)", () => {
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name.endsWith(".ts")) out.push(readFileSync(full, "utf8"));
      }
      return out;
    };
    const sources = walk(path.join(ADAPTER_ROOT, "src"));
    for (const text of sources) {
      expect(text).not.toMatch(/node-pty|vitest|\.\/helpers\//);
    }
  });

  it("build emits no source maps that would reference unpublished sources (§29)", () => {
    const tsconfig = readFileSync(path.join(ADAPTER_ROOT, "tsconfig.build.json"), "utf8");
    expect(tsconfig).toMatch(/"sourceMap":\s*false/);
  });
});
