/**
 * E13-T48..T51 — NO rollback (§50/§51): abort is a protocol stop, not an
 * undo. A real unaccepted workspace mutation made BEFORE the abort remains
 * on the filesystem afterward; acceptedHead is untouched; no git
 * reset/revert/checkout command is invoked by the abort path; no cleanup
 * Directive is ever issued.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { makeAcceptanceWorld } from "./acceptance-helpers.js";
import { explicitExecutionAbort, lifecycleOf } from "./session-recovery-helpers.js";

describe("E13 no rollback (§50/§51)", () => {
  it("E13-T48: the unaccepted workspace mutation made before the abort SURVIVES the abort", async () => {
    const world = await makeAcceptanceWorld("S1");
    // A real (unaccepted, uncommitted) workspace mutation inside the run's
    // workspace root — the exact candidate surface abort must NOT touch.
    const mutationPath = path.join(world.f.workspaceRoot, "src", "unaccepted-change.ts");
    fs.mkdirSync(path.dirname(mutationPath), { recursive: true });
    fs.writeFileSync(mutationPath, "// unaccepted candidate work — abort must never undo this\n");
    explicitExecutionAbort(world, { reason: "stop with dirty workspace" });
    expect(fs.existsSync(mutationPath)).toBe(true);
    expect(fs.readFileSync(mutationPath, "utf8")).toContain("abort must never undo this");
    expect(lifecycleOf(world)).toBe("aborted");
  });

  it("E13-T49: acceptedHead is byte-identical across the abort", async () => {
    const world = await makeAcceptanceWorld("S1");
    const before = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT accepted_head_commit_id AS h FROM execution_runs WHERE execution_run_id = ?").get(world.executionRunId) as { h: string | null },
    );
    explicitExecutionAbort(world, { reason: "stop" });
    const after = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT accepted_head_commit_id AS h FROM execution_runs WHERE execution_run_id = ?").get(world.executionRunId) as { h: string | null },
    );
    expect(after.h).toBe(before.h);
  });

  it("E13-T50: the abort path performs no git command (structural static proof)", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const srcRoot = path.resolve(__dirname, "../src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith(".ts")) {
          const text = readFileSync(full, "utf8");
          if (/abort/i.test(path.basename(full)) && /git\s+(reset|revert|checkout|restore|clean)/.test(text)) {
            offenders.push(path.basename(full));
          }
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });

  it("E13-T51: no cleanup/rollback Directive is issued by the abort", async () => {
    const world = await makeAcceptanceWorld("S1");
    const directivesBefore = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM execution_directives WHERE execution_run_id = ?").get(world.executionRunId) as { n: number },
    );
    explicitExecutionAbort(world, { reason: "stop" });
    const directivesAfter = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM execution_directives WHERE execution_run_id = ?").get(world.executionRunId) as { n: number },
    );
    expect(directivesAfter.n).toBe(directivesBefore.n);
    // And no directive of any cleanup shape exists anywhere on the run.
    const cleanup = world.ctx.store.withRead(
      (tx) =>
        tx
          .prepare("SELECT count(*) AS n FROM execution_directives WHERE execution_run_id = ? AND (objective LIKE '%rollback%' OR objective LIKE '%cleanup%' OR objective LIKE '%undo%')")
          .get(world.executionRunId) as { n: number },
    );
    expect(cleanup.n).toBe(0);
  });
});
