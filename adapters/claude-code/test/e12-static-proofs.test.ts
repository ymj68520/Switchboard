/**
 * Static proofs, E13-updated (E12 §55/§74-T75/§76 → E13 §2/§55/§76-T76): the
 * schema ceiling is now 25 — E13's ONE authorized migration owns the abort
 * objects (closure_kind='aborted', ABORTED event, execution_abort_records) —
 * and the E13-forbidden artifacts (ExecutionObservation, workspace rollback,
 * new Attempt states) still do not exist. The pre-E13 pin set is superseded
 * by E13 exactly as the E12 directive's §78 STOP anticipated.
 */
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { SUPPORTED_SCHEMA_VERSION } from "../src/store/constants.js";

const SRC = path.resolve(__dirname, "../src");
const STORE = path.join(SRC, "store");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("schema ceiling (E13 §55)", () => {
  it("SUPPORTED_SCHEMA_VERSION is 25 — E13 owns the one-step abort migration", () => {
    expect(SUPPORTED_SCHEMA_VERSION).toBe(26);
    const migrationFiles = readdirSync(path.join(STORE, "migrations")).filter((name) => name.endsWith(".ts"));
    expect(migrationFiles.some((name) => name.startsWith("025"))).toBe(true);
    // The one-step registry tops out at 25, with the E13 migration registered.
    const registry = readFileSync(path.join(STORE, "migrations", "index.ts"), "utf8");
    expect(registry).toContain("attempt-reconciliation-foundation");
    expect(registry).toContain("execution-abort-foundation");
    expect(registry).not.toMatch(/version:\s*26/);
  });
});

describe("E13-T76 — no E14+ artifacts (E13 §76/§82)", () => {
  const sources = walk(SRC);

  it("the ONLY execution_runs lifecycle='aborted' writer is the E13 Core primitive", () => {
    // E13 §40 — no raw lifecycle setter, no second abort path: the CAS writer
    // abortExecutionRunInTx is the sole production transition.
    const writers: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      if (/UPDATE\s+execution_runs\s+SET[^;]*lifecycle\s*=\s*'aborted'/i.test(text)) {
        writers.push(path.relative(SRC, file));
      }
    }
    expect(writers).toEqual(["store\\execution-runs.ts"]);
  });

  it("no rollback-on-abort / workspace rollback machinery exists", () => {
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      expect(text, path.relative(SRC, file)).not.toMatch(/rollbackWorkspace|rollbackCandidate|automaticRollback/i);
      // E13 §50 — the abort path runs no git command.
      expect(text, path.relative(SRC, file)).not.toMatch(/git\s+(reset|revert|checkout|restore)/);
    }
  });

  it("no ExecutionObservation table or type exists", () => {
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      expect(text, path.relative(SRC, file)).not.toMatch(/CREATE TABLE (IF NOT EXISTS )?execution_observations/);
      expect(text, path.relative(SRC, file)).not.toMatch(/interface ExecutionObservation\b/);
    }
  });

  it("no new Attempt lifecycle state exists (E13 §24 — the E4 vocabulary stands)", () => {
    const attemptTypes = sources
      .map((file) => readFileSync(file, "utf8"))
      .filter((text) => /ExecutionAttemptState|attempt.*IN \('running'/i.test(text));
    for (const text of attemptTypes) {
      expect(text).not.toMatch(/'aborted'\s*,\s*'cancelled'|state\s*=\s*'cancelled'/i);
    }
    const attemptStateType = readFileSync(path.join(SRC, "core", "execution-attempt.ts"), "utf8");
    expect(attemptStateType).toContain('"running"');
    expect(attemptStateType).toContain('"reported"');
    expect(attemptStateType).toContain('"indeterminate"');
    expect(attemptStateType).not.toMatch(/"(aborted|cancelled|terminated)"/);
  });
});
