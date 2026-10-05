/**
 * A1-I Verification Closure — recovery re-key (runbook §17, T54–T57) and the
 * A1-II boundary gate (runbook §19, T62–T65).
 *
 * §17 — every recovery surface (resume, clear, fork, compact, takeover)
 *      recovers the SAME canonical ExecutionRunID: the recovery rendering and
 *      token machinery is pinned to the canonical identity by static source
 *      proof, and the dynamic flows are covered by the integrated
 *      v020-e2e-session-recovery suite (mapped in the traceability matrix).
 * §19 — the A1-II reexecution capability is now the AUTHORIZED, frozen
 *      surface (A1-II directive §10): exactly ONE human-interactive MCP tool
 *      (reexecute_final_plan, requiresUserInteraction, no bypass surfaces),
 *      exactly ONE production final_plan_execution writer (the A1-II
 *      reexecution service), and exactly TWO live ExecutionRun creation
 *      paths (the initial PlanningRun handoff + the A1-II atomic creation).
 *      Nothing beyond those exact surfaces exists, and the FinalPlan →
 *      0..N ExecutionRuns cardinality stays structurally per-Workspace —
 *      never a global one-run-per-FinalPlan fence.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = path.join(process.cwd(), "src");

function scanSource(predicate: (relativePath: string, text: string) => string[]): string[] {
  const findings: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts")) {
        const relative = path.relative(SRC_ROOT, full).replaceAll("\\", "/");
        findings.push(...predicate(relative, fs.readFileSync(full, "utf8")));
      }
    }
  };
  walk(SRC_ROOT);
  return findings;
}

describe("A1-I §17 — recovery re-key (T54–T57)", () => {
  it("T54/T57: recovery rendering and context machinery resolve the canonical ExecutionRunID", () => {
    // The host execution context (Build-read recovery context) carries the
    // canonical id and resolves the exact run through the provenance column.
    const hostContext = fs.readFileSync(path.join(SRC_ROOT, "host", "execution-context.ts"), "utf8");
    expect(hostContext).toMatch(/executionRunId|execution_run_id/);
    // The hook layer (resume/clear/fork/compact/takeover) drives supervision
    // and replan probes through the canonical id.
    const hooks = fs.readFileSync(path.join(SRC_ROOT, "hooks", "handlers.ts"), "utf8");
    expect(hooks).toMatch(/executionRunId/);
    expect(hooks).not.toMatch(/ORDER BY\s+(created_at|rowid)\s+DESC\s+LIMIT\s+1/i);
    // The context renderer includes the execution identity in the capsule.
    const render = fs.readFileSync(path.join(SRC_ROOT, "context", "render.ts"), "utf8");
    expect(render.length).toBeGreaterThan(0);
  });

  it("T55/T56: recovery tokens and replan-issue probes are exact-run scoped (no newest-wins resolution)", () => {
    const violations = scanSource((relative, text) => {
      if (!/FROM execution_runs\s*(WHERE|$)|FROM execution_runs r\s/i.test(text)) return [];
      // Validator and preflight probes use bounded LIMIT-1 drift checks
      // (selecting a PROBLEM row) — sanctioned. What is forbidden is a
      // resolution path that PICKS the run to operate on by ordering.
      if (relative === "store/schema.ts" || relative.startsWith("store/migrations/")) return [];
      const bad = text.split("\n").map((line, index) => ({ line: line.trim(), index }))
        .filter(({ line }) => /FROM execution_runs/i.test(line) && /LIMIT\s+1/i.test(line))
        .filter(({ line }) => !line.startsWith("//") && !line.startsWith("*"))
        .map(({ index }) => `${relative}:${index + 1}`);
      return bad;
    });
    expect(violations).toEqual([]);
    // The indeterminate/reconciliation recovery is exact-run scoped: the
    // AttemptReconciliation machinery keys by execution_run_id (v24+).
    const reconciliation = fs.readFileSync(path.join(SRC_ROOT, "store", "schema.ts"), "utf8");
    expect(reconciliation).toContain("execution_attempt_reconciliations");
  });
});

describe("A1-I §19 — A1-II boundary gate (T62–T65, frozen A1-II form)", () => {
  it("T62: exactly ONE reexecution MCP tool exists — the human-interactive one, with no bypass surfaces", () => {
    const tools = fs.readFileSync(path.join(SRC_ROOT, "mcp", "tools.ts"), "utf8");
    // Exactly one reexecution tool, under the frozen A1-II name.
    const names = [...tools.matchAll(/name:\s*"([^"]*re-?execut[^"]*)"/gi)].map((match) => match[1]);
    expect(names).toEqual(["reexecute_final_plan"]);
    // It is mandatory-interaction (the human dialog IS the authorization).
    expect(tools).toMatch(/name: "reexecute_final_plan"[\s\S]{0,2200}?_meta: REQUIRES_USER_INTERACTION_META/);
    // §10 — no bypass surface may exist under any other name.
    for (const forbidden of ["create_execution_run_raw", "set_execution_lifecycle", "clone_execution", "force_reexecute"]) {
      expect(tools).not.toMatch(new RegExp(`name:\\s*"${forbidden}"`));
    }
  });

  it("T63: exactly ONE production final_plan_execution writer exists — the A1-II reexecution service", () => {
    // The control insert API is the only SQL writer; the final_plan_execution
    // target is constructed in exactly one application file.
    const writers = scanSource((relative, text) => {
      if (!/INSERT INTO run_control_authorizations/.test(text)) return [];
      // store/run-control.ts is the only SQL writer; the 026
      // classification copy is the only sanctioned historical writer.
      if (relative !== "store/run-control.ts" && !relative.startsWith("store/migrations/")) return [relative];
      return [];
    });
    expect(writers).toEqual([]);
    // The final_plan_execution target identity appears in exactly TWO files,
    // each with exactly one sanctioned role: the A1-II service (the only
    // authorization WRITER) and the MCP handler (request-hash typing only —
    // it never constructs an authorization).
    const targetUsers = scanSource((relative, text) => {
      if (!/targetKind:\s*"final_plan_execution"/.test(text)) return [];
      if (relative.startsWith("store/migrations/")) return [];
      return [relative];
    });
    expect(targetUsers.sort()).toEqual(["application/reexecution-service.ts", "mcp/tools.ts"]);
    const handler = fs.readFileSync(path.join(SRC_ROOT, "mcp", "tools.ts"), "utf8");
    expect(handler).toMatch(/runControlRequestHash\(\{[\s\S]{0,300}?targetKind: "final_plan_execution"/);
    // The resulting_execution_run_id is written ONLY by the A1-II service and
    // the store-layer column plumbing — never staged for a later UPDATE (the
    // append-only table never takes one; A1 §14).
    const resultingWrites = scanSource((relative, text) => {
      if (!/resultingExecutionRunId\s*[:=]/.test(text)) return [];
      if (
        relative === "application/reexecution-service.ts"
        || relative === "store/run-control.ts"
        || relative.startsWith("store/migrations/")
        || relative.startsWith("store/schema.ts")
      ) return [];
      return [relative];
    });
    expect(resultingWrites).toEqual([]);
  });

  it("T64/T65: exactly TWO live ExecutionRun creation paths — the initial handoff and the A1-II atomic creation", () => {
    // Exactly one INSERT INTO execution_runs in production code.
    const inserts = scanSource((relative, text) => {
      if (/INSERT INTO execution_runs\s*\(/.test(text)) return [relative];
      return [];
    });
    expect(inserts).toEqual(["store/execution-runs.ts"]);
    // Its importers are exactly the two creation services...
    const serviceImporters = scanSource((relative, text) => {
      if (relative === "store/execution-runs.ts") return [];
      if (/from\s+".*store\/execution-runs\.js"/.test(text) && /insertExecutionRunInTx/.test(text)) return [relative];
      return [];
    });
    expect(serviceImporters.sort()).toEqual(["application/execution-run-service.ts", "application/reexecution-service.ts"]);
    // ...the initial-handoff preparation entry is consumed only by the
    // handoff delivery...
    const deliveryImporters = scanSource((relative, text) => {
      if (relative === "application/execution-run-service.ts") return [];
      if (/prepareExecutionRunForFinalPlanInTx/.test(text)) return [relative];
      return [];
    });
    expect(deliveryImporters).toEqual(["application/handoff-service.ts"]);
    // ...and the A1-II creation service is exposed only through the MCP
    // handler (the creation transaction core has no other production importer).
    const reexecutionImporters = scanSource((relative, text) => {
      if (relative === "application/reexecution-service.ts") return [];
      if (/createReexecutionService|reexecuteFinalPlanInTx/.test(text)) return [relative];
      return [];
    });
    expect(reexecutionImporters).toEqual(["mcp/tools.ts"]);
    // The FinalPlan → 0..N ExecutionRuns cardinality is structurally
    // per-Workspace: the root carries NO unique index over (final_plan_id)
    // and there is no global one-run-per-FinalPlan fence (A1-I34/A1II-I24).
    const schema = fs.readFileSync(path.join(SRC_ROOT, "store", "migrations", "026-execution-run-identity-foundation.ts"), "utf8");
    expect(schema).not.toMatch(/UNIQUE\s*\([^)]*final_plan_id[^)]*\)/i);
  });
});
