/**
 * Release version contract (Phase 18 §3/§4): the plugin manifest is the
 * single hand-written release version; every other release identity derives
 * from it and must never drift. These checks run on every `npm test` so the
 * Phase 17 class of server-schema-cache drift cannot re-enter.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { RUNTIME_NAME, RUNTIME_VERSION, renderVersionBanner } from "../src/runtime/version.js";
import { SUPPORTED_SCHEMA_VERSION } from "../src/store/constants.js";
import { REQUIRED_NODE_VERSION } from "../src/runtime/node-version.js";
import { runtimeBundlePath } from "./helpers.js";

const ADAPTER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_ROOT = path.resolve(ADAPTER_ROOT, "..", "..", "release");
const manifest: { name: string; version: string; description?: string } = JSON.parse(
  readFileSync(path.join(ADAPTER_ROOT, ".claude-plugin", "plugin.json"), "utf8"),
);

describe("release version contract (§3/§4)", () => {
  it("derives the runtime identity from the plugin manifest", () => {
    expect(RUNTIME_NAME).toBe(manifest.name);
    expect(RUNTIME_VERSION).toBe(manifest.version);
  });

  it("keeps the plugin identity frozen as phase-plan (§56)", () => {
    expect(manifest.name).toBe("phase-plan");
  });

  it("uses a valid semver release version", () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  it("documents the release in the CHANGELOG under its exact version heading (§40)", () => {
    const changelog = readFileSync(path.join(ADAPTER_ROOT, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain(`## ${RUNTIME_VERSION}`);
  });

  it("ships every allowlisted release-tree input (§7)", () => {
    for (const rel of [
      ".claude-plugin/plugin.json",
      ".mcp.json",
      "hooks/hooks.json",
      "skills/phase-plan/SKILL.md",
      "agents/validator.md",
      "dist/phase-plan-runtime.mjs",
      "README.md",
      "CHANGELOG.md",
    ]) {
      expect(existsSync(path.join(ADAPTER_ROOT, ...rel.split("/"))), rel).toBe(true);
    }
  });

  it("renders the §37 version banner without paths or environment facts", () => {
    const banner = renderVersionBanner(SUPPORTED_SCHEMA_VERSION, REQUIRED_NODE_VERSION);
    const lines = banner.split("\n");
    expect(lines[0]).toBe(`phase-plan ${RUNTIME_VERSION}`);
    expect(lines[1]).toBe(`schema support ${SUPPORTED_SCHEMA_VERSION}`);
    expect(lines[2]).toBe(`required Node >=${REQUIRED_NODE_VERSION}`);
    expect(banner).not.toMatch(/[/\\]/);
  });

  it("keeps the release manifest coherent with the manifest version when one has been built (§38)", () => {
    const metadataPath = path.join(RELEASE_ROOT, `phase-plan-${RUNTIME_VERSION}-release.json`);
    if (!existsSync(metadataPath)) {
      return; // no release build on this checkout — the release script asserts this strongly at build time
    }
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    expect(metadata.version).toBe(RUNTIME_VERSION);
    expect(metadata.product).toBe("phase-plan");
    expect(metadata.schemaVersion).toBe(SUPPORTED_SCHEMA_VERSION);
    expect(metadata.toolCount).toBe(18);
    const zipPath = path.join(RELEASE_ROOT, metadata.artifact);
    expect(existsSync(zipPath)).toBe(true);
    expect(metadata.artifactSha256).toBe(createHash("sha256").update(readFileSync(zipPath)).digest("hex"));
  });
});

describe("bundled runtime artifact invariants (§14/§36)", () => {
  const bundle = readFileSync(runtimeBundlePath(), "utf8");

  it("keeps node:sqlite out of the eager import graph so doctor/--version run on old Node", () => {
    const eagerImports = bundle.split("\n").filter((line) => /^import\b[^;]*['"]node:sqlite['"]/.test(line));
    expect(eagerImports).toEqual([]);
  });

  it("resolves node:sqlite lazily through the createRequire capture", () => {
    expect(bundle).toContain("createRequire");
    expect(bundle).toContain('"node:sqlite"');
  });

  it("contains no temporary Phase 17 diagnostics (§36)", () => {
    expect(bundle).not.toContain("P17DIAG");
    expect(bundle).not.toContain("TEMP DEBUG");
  });
});
