import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static import-boundary enforcement (§33/§44/§75/§76/E43/E44/E45).
 *
 * The committed-memory write primitives and HEAD movers may have exactly ONE
 * production caller — the PlanCommit Transaction Engine. The test-only user
 * authorization factory must never appear on any production surface. No
 * production module may fake approval authority.
 */

const SRC_ROOT = path.resolve(__dirname, "../src");
const TEST_ROOT = path.resolve(__dirname);

function listFiles(root: string, extension: ".ts" | ".mjs"): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(extension)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

function readImports(filePath: string): string[] {
  const text = fs.readFileSync(filePath, "utf8");
  return [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]!);
}

function readModuleText(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

/** Production modules allowed to touch the raw committed-memory writer. */
const WRITER_ALLOWED = new Set([
  path.join(SRC_ROOT, "store", "plan-memory.ts"),
  path.join(SRC_ROOT, "application", "plan-commit-engine.ts"),
]);

describe("committed-memory writer boundary (§75/E43/E44)", () => {
  it("only plan-memory.ts (definition) and the PlanCommit engine import the raw writer primitives", () => {
    const offenders: string[] = [];
    for (const file of listFiles(SRC_ROOT, ".ts")) {
      if (WRITER_ALLOWED.has(path.resolve(file))) continue;
      const imports = readImports(file).join(" ");
      if (/plan-memory(\.js)?["']/.test(imports)) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("setHeadSnapshotInTx / insert*InTx are not re-exported from any public application surface", () => {
    for (const file of listFiles(SRC_ROOT, ".ts")) {
      if (path.resolve(file) === path.join(SRC_ROOT, "store", "plan-memory.ts")) continue;
      const text = readModuleText(file);
      expect(text).not.toMatch(/export\s+[^;]*setHeadSnapshotInTx/);
      expect(text).not.toMatch(/export\s+[^;]*insertMemoryRevisionInTx/);
      expect(text).not.toMatch(/export\s+[^;]*insertSnapshotInTx/);
    }
  });
});

describe("test-only authorization factory boundary (§33)", () => {
  it("makeTestUserAuthorization exists only under test/ and is imported by no production module", () => {
    // The factory lives in the test tree only.
    const testHelpers = path.join(TEST_ROOT, "proposal-helpers.ts");
    expect(readModuleText(testHelpers)).toContain("makeTestUserAuthorization");

    for (const file of listFiles(SRC_ROOT, ".ts")) {
      const text = readModuleText(file);
      expect(text).not.toContain("makeTestUserAuthorization");
    }
  });
});

describe("no fake approval authority exists (§32/§74/E45)", () => {
  it("no production module contains natural-language approval or approved=true seams", () => {
    for (const file of listFiles(SRC_ROOT, ".ts")) {
      const text = readModuleText(file);
      expect(text).not.toMatch(/approved\s*=\s*true/);
      expect(text).not.toMatch(/isTrusted\s*\?\?\s*true/);
      expect(text).not.toMatch(/force\s*\?\?\s*true/);
      // §74: no NLP approval judgment — user-language tokens must never
      // decide an approval. (SQLite error classification via message.includes
      // is unrelated and legal.)
      expect(text).not.toMatch(/includes\(["'](可以|同意|approve|approved|allow|yes)["']/);
    }
  });
});
