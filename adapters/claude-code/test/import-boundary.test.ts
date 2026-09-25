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

/**
 * Phase 8: the authoritative context read model is the ONE additional
 * production consumer of plan-memory.ts — restricted to the documented
 * READ APIs (plan-memory.ts itself lists the read side as the sanctioned
 * surface for future context-assembler consumers). Write primitives stay
 * engine-only below.
 */
const READ_ONLY_ALLOWED = new Set([path.join(SRC_ROOT, "application", "context-read-model.ts")]);

/**
 * The transaction-scoped WRITE primitives (engine-only, §75/E43/E44), the
 * Phase 9 Observation writer (hook-side capture only, §71) and the Phase 9
 * Evidence writer (application domain writer only, §71).
 */
const WRITE_PRIMITIVE_SYMBOLS =
  /insertArtifactIdentityInTx|insertMemoryRevisionInTx|insertSnapshotInTx|setHeadSnapshotInTx|createInternalPlanMemoryWriter/;
const OBSERVATION_WRITE_SYMBOLS = /insertObservationInTx/;
const EVIDENCE_WRITE_SYMBOLS = /insertEvidenceArtifactInTx|insertEvidenceRevisionInTx|insertEvidenceRefsInTx/;

/** Production modules allowed to touch the raw Observation writer. */
const OBSERVATION_WRITER_ALLOWED = new Set([
  path.join(SRC_ROOT, "store", "observations.ts"),
  path.join(SRC_ROOT, "observations", "capture.ts"),
]);

/** Production modules allowed to touch the raw Evidence writers. */
const EVIDENCE_WRITER_ALLOWED = new Set([
  path.join(SRC_ROOT, "store", "evidence.ts"),
  path.join(SRC_ROOT, "application", "evidence-service.ts"),
]);

function namedImportsOf(text: string, modulePattern: RegExp): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    if (!modulePattern.test(match[2]!)) continue;
    for (const specifier of match[1]!.split(",")) {
      const name = specifier.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
      if (name !== "") names.push(name);
    }
  }
  return names;
}

describe("committed-memory writer boundary (§75/E43/E44)", () => {
  it("only plan-memory.ts (definition) and the PlanCommit engine import the raw writer primitives", () => {
    const offenders: string[] = [];
    for (const file of listFiles(SRC_ROOT, ".ts")) {
      if (WRITER_ALLOWED.has(path.resolve(file))) continue;
      const text = readModuleText(file);
      const names = namedImportsOf(text, /plan-memory(\.js)?$/);
      if (names.some((name) => WRITE_PRIMITIVE_SYMBOLS.test(name))) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("only capture.ts imports the Observation writer (hook-side capture, Phase 9 §71)", () => {
    const offenders: string[] = [];
    for (const file of listFiles(SRC_ROOT, ".ts")) {
      if (OBSERVATION_WRITER_ALLOWED.has(path.resolve(file))) continue;
      const text = readModuleText(file);
      const names = namedImportsOf(text, /store\/observations(\.js)?$/);
      if (names.some((name) => OBSERVATION_WRITE_SYMBOLS.test(name))) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("only the Evidence application service imports the Evidence writers (§71)", () => {
    const offenders: string[] = [];
    for (const file of listFiles(SRC_ROOT, ".ts")) {
      if (EVIDENCE_WRITER_ALLOWED.has(path.resolve(file))) continue;
      const text = readModuleText(file);
      const names = namedImportsOf(text, /store\/evidence(\.js)?$/);
      if (names.some((name) => EVIDENCE_WRITE_SYMBOLS.test(name))) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("plan-memory.ts imports are confined to the engine (write) and the context read model (read-only)", () => {
    const offenders: string[] = [];
    for (const file of listFiles(SRC_ROOT, ".ts")) {
      const resolved = path.resolve(file);
      if (WRITER_ALLOWED.has(resolved) || READ_ONLY_ALLOWED.has(resolved)) continue;
      if (readImports(file).join(" ").match(/plan-memory(\.js)?["']/)) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the context read model never imports a write primitive (read-only carve-out)", () => {
    const text = readModuleText(path.join(SRC_ROOT, "application", "context-read-model.ts"));
    const names = namedImportsOf(text, /plan-memory(\.js)?$/);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => WRITE_PRIMITIVE_SYMBOLS.test(name))).toEqual([]);
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
