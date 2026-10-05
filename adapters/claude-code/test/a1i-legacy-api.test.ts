/**
 * A1-I Verification Closure — legacy API ambiguity (runbook §16, T49–T53).
 *
 * Every dual-input resolution case through the shared normalization helper
 * (resolveExecutionRunIdentity) and through the real MCP tool path:
 * canonical-only succeeds, legacy 0-matches → NOT_FOUND, legacy 1-match →
 * compatibility success, canonical+legacy same-world → success, conflicting
 * inputs → AMBIGUOUS, and a legacy run_id held by TWO execution worlds →
 * AMBIGUOUS (never "newest wins"; no LIMIT 1 exists on the path).
 */
import { describe, expect, it } from "vitest";

import { makeActiveExecutionWorld } from "./execution-protocol-helpers.js";
import { executePhasePlanTool } from "../src/mcp/tools.js";
import { resolveExecutionRunIdentity } from "../src/mcp/tools.js";
import { hostTokenV2 } from "./phase12-helpers.js";
import { discoverAndRegisterWorkspace } from "../src/workspace/identity.js";
import { fixedClock, removeTempPluginDataRoot } from "./store-helpers.js";
import * as path from "node:path";
import * as fs from "node:fs";

function pluginDataRootOf(store: { path: string }): string {
  return path.dirname(path.dirname(store.path));
}

describe("A1-I §16 — the shared identity normalization matrix (T49–T52)", () => {
  it("T49–T52: all five single-world dual-input resolution cases behave exactly as specified", async () => {
    const w = await makeActiveExecutionWorld(`A1I-ID-${Math.random().toString(36).slice(2, 8)}`);
    try {
      const viaHelper = (rawArgs: Record<string, unknown>, requireExisting = true): { executionRunId?: string; legacyRunId: string } | { code: string } => {
        try {
          return resolveExecutionRunIdentity(w.ctx, rawArgs, { requireExisting }) as { executionRunId?: string; legacyRunId: string };
        } catch (err) {
          return { code: (err as { code?: string }).code ?? String(err) };
        }
      };

      // 1. canonical only → exact canonical execution
      expect(viaHelper({ execution_run_id: w.executionRunId })).toMatchObject({ executionRunId: w.executionRunId });
      // 2. legacy run_id with 0 matches → NOT FOUND (requireExisting)
      expect(viaHelper({ run_id: "plan_no_such_run" })).toMatchObject({ code: "EXECUTION_RUN_NOT_FOUND" });
      // (a non-mutating probe may omit the requirement)
      expect(viaHelper({ run_id: "plan_no_such_run" }, false)).toMatchObject({ legacyRunId: "plan_no_such_run" });
      // 3. legacy run_id with exactly 1 match → compatibility success
      expect(viaHelper({ run_id: w.f.runId })).toMatchObject({ executionRunId: w.executionRunId, legacyRunId: w.f.runId });
      // 4. canonical + legacy resolving to the same world → success
      expect(viaHelper({ execution_run_id: w.executionRunId, run_id: w.f.runId })).toMatchObject({ executionRunId: w.executionRunId });
      // 5. canonical + legacy in conflict → reject
      expect(viaHelper({ execution_run_id: w.executionRunId, run_id: w.f.runId + "-other" })).toMatchObject({ code: "EXECUTION_RUN_AMBIGUOUS" });
    } finally {
      w.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(w.ctx.store));
    }
  });

  it("T52b: a legacy run_id held by two execution worlds is AMBIGUOUS — the two-run fixture proves no newest-wins fallback", async () => {
    const { w, e2 } = await buildTwoRunWorld();
    try {
      // Exactly two worlds share the provenance run_id here.
      const worlds = w.ctx.store.withRead(
        (tx) => tx.prepare("SELECT count(*) AS n FROM execution_runs WHERE run_id = ?").get(w.f.runId) as { n: number },
      ).n;
      expect(worlds).toBe(2);
      const err = (() => {
        try {
          resolveExecutionRunIdentity(w.ctx, { run_id: w.f.runId }, { requireExisting: true });
          return null;
        } catch (e) {
          return e as { code?: string };
        }
      })();
      expect(err?.code).toBe("EXECUTION_RUN_AMBIGUOUS");
      void e2;
    } finally {
      w.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(w.ctx.store));
    }
  });
});

describe("A1-I §16 — the real tool path accepts both inputs (T53)", () => {
  it("T53: takeover_run with the LEGACY run_id resolves to the canonical execution; abort with the canonical id succeeds", async () => {
    const w = await makeActiveExecutionWorld(`A1I-LEG-${Math.random().toString(36).slice(2, 8)}`);
    try {
      const token = hostTokenV2(w.ctx.secret, "takeover_run", { run_id: w.f.runId, expected_binding_generation: w.f.generation }, { sessionId: "S2", workspaceId: w.f.workspaceId }, { permissionMode: "plan", toolUseId: "TU-A1I-LEG" });
      const result = executePhasePlanTool(w.ctx, "takeover_run", { run_id: w.f.runId, expected_binding_generation: w.f.generation, _hostContext: token }) as {
        supervisor?: { execution_run_id: string };
      };
      expect(result.supervisor?.execution_run_id).toBe(w.executionRunId);
      // The canonical id resolves identically on the same path.
      const token2 = hostTokenV2(w.ctx.secret, "takeover_run", { execution_run_id: w.executionRunId, expected_binding_generation: 2 }, { sessionId: "S3", workspaceId: w.f.workspaceId }, { permissionMode: "plan", toolUseId: "TU-A1I-LEG2" });
      const result2 = executePhasePlanTool(w.ctx, "takeover_run", { execution_run_id: w.executionRunId, expected_binding_generation: 2, _hostContext: token2 }) as {
        supervisor?: { execution_run_id: string; generation: number };
      };
      expect(result2.supervisor?.execution_run_id).toBe(w.executionRunId);
      expect(result2.supervisor?.generation).toBe(3);
    } finally {
      w.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(w.ctx.store));
    }
  });
});

/** The §15 schema-only two-run fixture, re-created locally (same shape as
 * the isolation suite): a second ExecutionRun under the SAME FinalPlan in a
 * SECOND workspace. */
async function buildTwoRunWorld() {
  const w = await makeActiveExecutionWorld(`A1I-LEG2-${Math.random().toString(36).slice(2, 8)}`);
  const projectDir2 = path.join(pluginDataRootOf(w.ctx.store), "project-2");
  fs.mkdirSync(projectDir2, { recursive: true });
  const { registration } = await discoverAndRegisterWorkspace(w.ctx.store, projectDir2, fixedClock({ ids: ["leg-r2", "leg-w2"] }));
  const runRow = w.ctx.store.withRead(
    (tx) => tx.prepare("SELECT run_id AS rid, final_plan_id AS fp, final_plan_revision AS fprev, final_plan_hash AS fph, planning_baseline_json AS pb, execution_start_baseline_json AS eb, created_at AS ca, updated_at AS ua FROM execution_runs WHERE execution_run_id = ?").get(w.executionRunId) as Record<string, string | number>,
  );
  w.ctx.store.withWrite((tx) => {
    tx.prepare(
      "INSERT INTO execution_runs (execution_run_id, run_id, workspace_id, final_plan_id, final_plan_revision, final_plan_hash, lifecycle, planning_baseline_json, execution_start_baseline_json, revision, created_at, updated_at) "
      + "VALUES ('exec-legacy-e2', ?, ?, ?, ?, ?, 'prepared', ?, ?, 1, ?, ?)",
    ).run(runRow.rid as string, registration.workspace.workspaceId, runRow.fp as string, runRow.fprev as number, runRow.fph as string, runRow.pb as string, runRow.eb as string, runRow.ca as string, runRow.ua as string);
  });
  return { w, e2: "exec-legacy-e2" };
}
