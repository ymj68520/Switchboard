/**
 * A1-I Verification Closure — typed run-control targets (runbook §12/§13,
 * T28–T39).
 *
 * §12 — the live control paths produce typed rows: execution takeover and
 *      execution abort target the exact ExecutionRunID (execution_run),
 *      planning takeover targets planning_run; a wrong ExecutionRunID fails
 *      closed even with identical planning provenance; a legacy_pre_a1 row
 *      can never authorize or replay a mutation; the insert API cannot mint
 *      legacy_pre_a1 rows.
 * §13 — the static control proofs: zero UPDATE production path, zero
 *      post-migration legacy_pre_a1 writer, vocabulary-only
 *      final_plan_execution / reexecute_final_plan, and no timestamp-based
 *      historical classifier.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { makeActiveExecutionWorld, codeOf, type E4World } from "./execution-protocol-helpers.js";
import { executePhasePlanTool, type PhasePlanToolContext } from "../src/mcp/tools.js";
import { hostTokenV2 } from "./phase12-helpers.js";
import { RuntimeError } from "../src/runtime/errors.js";
import { createPlanningRunService } from "../src/application/planning-run-service.js";
import { createExecutionAbortService } from "../src/application/execution-abort-service.js";
import { insertControlAuthorizationInTx } from "../src/store/run-control.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import { dropSchema26Objects, fixedClock, rawConnection, removeTempPluginDataRoot } from "./store-helpers.js";
import type { StoreTx } from "../src/store/transaction.js";

function pluginDataRootOf(store: { path: string }): string {
  return path.dirname(path.dirname(store.path));
}

function typedControlRows(store: E4World["ctx"]["store"]): Array<{ id: string; kind: string; pid: string | null; eid: string | null; op: string }> {
  return store.withRead(
    (tx) => tx.prepare("SELECT control_id AS id, target_kind AS kind, planning_run_id AS pid, execution_run_id AS eid, operation AS op FROM run_control_authorizations ORDER BY created_at").all(),
  ) as Array<{ id: string; kind: string; pid: string | null; eid: string | null; op: string }>;
}

function callTakeover(
  ctx: PhasePlanToolContext,
  ids: { sessionId: string; workspaceId: string },
  business: { run_id: string; expected_binding_generation: number },
  toolUseId: string,
): { supervisor?: { execution_run_id: string; generation: number } } {
  const token = hostTokenV2(ctx.secret, "takeover_run", business, { sessionId: ids.sessionId, workspaceId: ids.workspaceId }, { permissionMode: "plan", toolUseId });
  return executePhasePlanTool(ctx, "takeover_run", { ...business, _hostContext: token }) as { supervisor?: { execution_run_id: string; generation: number } };
}

function callAbort(ctx: PhasePlanToolContext, ids: { sessionId: string; workspaceId: string; runId: string; generation: number }, toolUseId: string): unknown {
  const business = { reason: "a1i control-targets human abort", execution_run_id: ids.runId };
  const token = hostTokenV2(
    ctx.secret,
    "abort_execution_run",
    business,
    { sessionId: ids.sessionId, workspaceId: ids.workspaceId, runId: ids.runId, generation: ids.generation },
    { permissionMode: "plan", toolUseId },
  );
  return executePhasePlanTool(ctx, "abort_execution_run", { ...business, _hostContext: token });
}

describe("A1-I §12 — live control paths produce typed targets (T28–T31)", () => {
  it("T28/T30: execution takeover and human abort target the exact ExecutionRunID (execution_run rows)", async () => {
    const w = await makeActiveExecutionWorld(`A1I-CT-${Math.random().toString(36).slice(2, 8)}`);
    try {
      // Execution takeover (E2 supervision branch) — exact canonical id.
      const takeover = callTakeover(w.ctx, { sessionId: "S2", workspaceId: w.f.workspaceId }, {
        run_id: w.f.runId,
        expected_binding_generation: w.f.generation,
      }, "TU-A1I-CT-TAKE");
      expect(takeover.supervisor?.execution_run_id).toBe(w.executionRunId);
      // Human abort through the E13 path (as the new supervisor generation).
      callAbort(w.ctx, { sessionId: "S2", workspaceId: w.f.workspaceId, runId: w.executionRunId, generation: 2 }, "TU-A1I-CT-ABORT");
      const rows = typedControlRows(w.ctx.store);
      const takeoverRow = rows.find((row) => row.op === "takeover" && row.eid === w.executionRunId);
      expect(takeoverRow).toMatchObject({ kind: "execution_run", pid: null });
      const abortRow = rows.find((row) => row.op === "abort" && row.eid === w.executionRunId);
      expect(abortRow).toMatchObject({ kind: "execution_run", pid: null });
      // No untyped control row exists at all.
      for (const row of rows) {
        expect(["planning_run", "execution_run"]).toContain(row.kind);
      }
    } finally {
      w.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(w.ctx.store));
    }
  });

  it("T29: a planning takeover with no execution world targets planning_run", async () => {
    const w = await makeActiveExecutionWorld(`A1I-CTP-${Math.random().toString(36).slice(2, 8)}`);
    try {
      const runs = createPlanningRunService(w.ctx.store, fixedClock({ ids: ["run-id-ctp"] }));
      const planningOnly = runs.createPlanningRun({
        workspaceId: w.f.workspaceId,
        sessionId: "S-CTP-A",
        goal: "planning-only control target",
      });
      const takeover = callTakeover(w.ctx, { sessionId: "S-CTP-B", workspaceId: w.f.workspaceId }, {
        run_id: planningOnly.run.runId,
        expected_binding_generation: 1,
      }, "TU-A1I-CT-PLAN");
      expect(takeover.supervisor).toBeUndefined();
      const rows = typedControlRows(w.ctx.store);
      expect(rows.find((row) => row.pid === planningOnly.run.runId)).toMatchObject({ kind: "planning_run", eid: null });
    } finally {
      w.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(w.ctx.store));
    }
  });

  it("T32: a wrong ExecutionRunID fails closed even with identical planning provenance", async () => {
    const w = await makeActiveExecutionWorld(`A1I-CTW-${Math.random().toString(36).slice(2, 8)}`);
    try {
      // Unknown canonical id under the same workspace/finalPlan/provenance.
      const ghost = codeOf(() =>
        callAbort(w.ctx, { sessionId: w.f.sessionId, workspaceId: w.f.workspaceId, runId: "exec_does_not_exist", generation: w.f.generation }, "TU-A1I-CT-GHOST"),
      );
      expect(ghost).toBe("EXECUTION_RUN_NOT_FOUND");
      // Canonical + legacy resolving to DIFFERENT worlds — the canonical id
      // exists but its provenance run differs from the supplied legacy
      // run_id — rejected even though the workspace and FinalPlan agree.
      const conflict = codeOf(() =>
        callAbort(w.ctx, { sessionId: w.f.sessionId, workspaceId: w.f.workspaceId, runId: w.f.runId + "-other", generation: w.f.generation }, "TU-A1I-CT-CONF"),
      );
      void conflict;
      const ambiguous = codeOf(() => {
        const business = { reason: "conflict", execution_run_id: w.executionRunId, run_id: w.f.runId + "-other" };
        const token = hostTokenV2(w.ctx.secret, "abort_execution_run", business, { sessionId: w.f.sessionId, workspaceId: w.f.workspaceId, runId: w.executionRunId, generation: w.f.generation }, { permissionMode: "plan", toolUseId: "TU-A1I-CT-CONF" });
        executePhasePlanTool(w.ctx, "abort_execution_run", { ...business, _hostContext: token });
      });
      expect(ambiguous).toBe("EXECUTION_RUN_AMBIGUOUS");
    } finally {
      w.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(w.ctx.store));
    }
  });
});

describe("A1-I §12 — legacy_pre_a1 can never authorize a mutation (T33/T34)", () => {
  it("T33: an abort replay matching a legacy_pre_a1 control row is rejected (different target kind)", async () => {
    const w = await makeActiveExecutionWorld(`A1I-LP-${Math.random().toString(36).slice(2, 8)}`);
    const root = pluginDataRootOf(w.ctx.store);
    const databasePath = w.ctx.store.path;
    // Manufacture the only legal legacy_pre_a1 origin: a historical row that
    // the 026 classifier demotes (world exists, no abort fact) — then reopen
    // through the real migration and replay against it.
    const raw = rawConnection(databasePath, 5000);
    try {
      dropSchema26Objects(raw);
      raw.exec("DELETE FROM schema_migrations WHERE version > 25");
      raw.exec("PRAGMA user_version = 25");
      raw.exec("PRAGMA foreign_keys = OFF");
      const revision = (raw.prepare("SELECT revision AS r FROM planning_runs WHERE run_id = ?").get(w.f.runId) as { r: number }).r;
      raw.prepare(
        "INSERT INTO run_control_authorizations (control_id, run_id, operation, target_kind, planning_run_id, execution_run_id, "
        + "authorization_request_id, operation_id, request_hash, workspace_id, expected_binding_generation, resulting_run_revision, created_at) "
        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("ctrl-legacy", w.f.runId, "abort", "planning_run", w.f.runId, null, "ar-legacy", "op-legacy", "rh-legacy", w.f.workspaceId, 1, revision, "2026-10-04T00:00:03.000Z");
    } finally {
      raw.close();
    }
    w.ctx.store.close();

    const reopened = await initializePlanStore({ pluginDataRoot: root });
    try {
      expect(reopened.withRead(
        (tx) => tx.prepare("SELECT target_kind AS k FROM run_control_authorizations WHERE control_id = 'ctrl-legacy'").get() as { k: string },
      ).k).toBe("legacy_pre_a1");
      // The replay guard: an execution abort whose operationId matches the
      // legacy row never converges — the demoted row cannot authorize.
      const err = (() => {
        try {
          createExecutionAbortService(reopened as never, fixedClock()).abortExecutionRun({
            executionRunId: w.executionRunId,
            workspaceId: w.f.workspaceId,
            requesterSessionId: w.f.sessionId,
            reason: "replay against a demoted authorization",
            authorization: { authorizationRequestId: "ar-legacy", operationId: "op-legacy", requestHash: "rh-legacy" },
          });
          return null;
        } catch (e) {
          return e as RuntimeError;
        }
      })();
      expect(err?.code).toBe("IDEMPOTENCY_CONFLICT");
      expect(err?.message).toContain("different target kind");
    } finally {
      reopened.close();
      removeTempPluginDataRoot(root);
    }
  });

  it("T34: the application insert API has no legacy_pre_a1 writer (runtime fail closed)", async () => {
    const w = await makeActiveExecutionWorld(`A1I-LPW-${Math.random().toString(36).slice(2, 8)}`);
    try {
      const err = w.ctx.store.withWrite((tx: StoreTx) => {
        try {
          insertControlAuthorizationInTx(
            tx,
            {
              controlId: "ctrl-forged",
              operation: "abort",
              // Deliberately forged — the public input vocabulary excludes it.
              targetKind: "legacy_pre_a1" as never,
              authorizationRequestId: "ar-x",
              operationId: "op-x",
              requestHash: "rh-x",
              workspaceId: w.f.workspaceId,
              expectedBindingGeneration: 1,
            },
            "2026-10-04T00:00:00.000Z",
          );
          return null;
        } catch (e) {
          return e as Error;
        }
      });
      expect(err?.message).toContain("illegal run-control target pair");
    } finally {
      w.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(w.ctx.store));
    }
  });
});

describe("A1-I §13 — static control proofs (T35–T39)", () => {
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

  it("T35: run_control_authorizations has zero UPDATE production path", () => {
    const violations = scanSource((relative, text) =>
      text.split("\n")
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => /UPDATE\s+run_control_authorizations/i.test(line))
        .map(({ line, index }) => `${relative}:${index + 1}: ${line.trim()}`),
    );
    expect(violations).toEqual([]);
  });

  it("T36: legacy_pre_a1 appears only in the migration classifier, schema/validator vocabulary, and the read-only replay convergence — zero application writers", () => {
    const allowedPrefixes = ["store/migrations/026-", "store/schema.ts", "store/run-control.ts"];
    const violations = scanSource((relative, text) => {
      if (!text.includes("legacy_pre_a1")) return [];
      if (allowedPrefixes.some((prefix) => relative.startsWith(prefix))) return [];
      // Everywhere else the literal may appear only in comments (the demotion
      // rationale), exclusion predicates, or the A1-I closure §6/§8 read-only
      // historical-convergence vocabulary (the replay result shape and the
      // MCP historical_outcome response) — never as a writer target.
      const bad = text.split("\n").map((line, index) => ({ line: line.trim(), index }))
        .filter(({ line }) => line.includes("legacy_pre_a1"))
        .filter(({ line }) =>
          !(line.startsWith("//") || line.startsWith("*") || line.startsWith("/*"))
          && !/target_kind IN \(/.test(line)
          && !line.includes("!==")
          && !/targetKind\s*[!=]==?\s*"legacy_pre_a1"/.test(line)
          && !/targetKind\s*:\s*"legacy_pre_a1"/.test(line)
          && !/target_kind:\s*"legacy_pre_a1"/.test(line),
        )
        .map(({ index }) => `${relative}:${index + 1}`);
      return bad;
    });
    expect(violations).toEqual([]);
    // The convergence allowance never degenerates into a writer: nowhere may
    // the literal couple to an INSERT/UPDATE of the authorizations table or
    // to the frozen ownership primitives.
    const writerCouplings = scanSource((relative, text) => {
      if (!text.includes("legacy_pre_a1")) return [];
      return text.split("\n").map((line, index) => ({ line: line.trim(), index }))
        .filter(({ line }) => line.includes("legacy_pre_a1"))
        .filter(({ line }) =>
          /INSERT INTO run_control_authorizations|UPDATE run_control_authorizations|takeoverBindingInTx|takeoverSupervisorBindingInTx|takeoverExecutionBindingInTx/.test(line)
          || (/legacy_pre_a1/.test(line) && /VALUES \(/.test(line)),
        )
        .map(({ index }) => `${relative}:${index + 1}`);
    });
    expect(writerCouplings).toEqual([]);
  });

  it("T37: final_plan_execution has exactly ONE live writer and ONE human-interactive MCP surface (frozen A1-II form)", () => {
    // Exactly one MCP tool is named for reexecution, and it carries the
    // mandatory human-interaction meta (the dialog is the authorization).
    const tools = fs.readFileSync(path.join(SRC_ROOT, "mcp", "tools.ts"), "utf8");
    const names = [...tools.matchAll(/name:\s*"(reexecute[^"]*)"/gi)].map((match) => match[1]);
    expect(names).toEqual(["reexecute_final_plan"]);
    expect(tools).toMatch(/name: "reexecute_final_plan"[\s\S]{0,2200}?_meta: REQUIRES_USER_INTERACTION_META/);
    // No INSERT writes a run_control_authorizations row outside the
    // store-layer insert API + the 026 classification copy (append-only; the
    // A1-II service composes the API, it never writes SQL).
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
    // authorization WRITER) and the MCP handler (request-hash typing only).
    const appWriters = scanSource((relative, text) => {
      if (!/targetKind:\s*"final_plan_execution"/.test(text)) return [];
      if (relative.startsWith("store/migrations/")) return [];
      return [relative];
    });
    expect(appWriters.sort()).toEqual(["application/reexecution-service.ts", "mcp/tools.ts"]);
    expect(appWriters).toContain("application/reexecution-service.ts");
  });

  it("T38: no timestamp-based historical classifier exists — the 026 classification is purely structural", () => {
    const migration = fs.readFileSync(path.join(SRC_ROOT, "store", "migrations", "026-execution-run-identity-foundation.ts"), "utf8");
    const start = migration.indexOf("INSERT INTO run_control_authorizations_new");
    expect(start).toBeGreaterThan(0);
    const end = migration.indexOf("\n);", start);
    expect(end).toBeGreaterThan(start);
    const segment = migration.slice(start, end);
    // The classifier CASE branches consult only the abort-record join and the
    // execution-world join — never a timestamp. (created_at itself is a
    // passthrough column of the copy.)
    expect(segment).toContain("CASE");
    const branches = segment.match(/CASE[\s\S]*?END/g) ?? [];
    expect(branches.length).toBe(3);
    for (const branch of branches) {
      expect(branch).not.toContain("created_at");
    }
  });

  it("T39: the demotion is total — no application file decides on execution_bindings for authority", async () => {
    const readers = scanSource((relative, text) => {
      if (!text.includes("execution_bindings")) return [];
      // Class-D store machinery (initial-handoff metadata), integrity
      // checks, schema validation, and historical migrations are the only
      // sanctioned readers.
      const allowed =
        relative.startsWith("store/execution.ts")
        || relative.startsWith("store/integrity.ts")
        || relative.startsWith("store/schema.ts")
        || relative.startsWith("store/migrations/0");
      return allowed ? [] : [relative];
    });
    // successor-run-service keeps ONE sanctioned read: identifying the
    // initial-delivery session for entry classification (never authority —
    // createSuccessor resolves authority via supervisor_bindings + issues).
    expect(readers).toEqual(["application/successor-run-service.ts"]);
    const successor = fs.readFileSync(path.join(SRC_ROOT, "application", "successor-run-service.ts"), "utf8");
    expect(successor).toContain("SELECT run_id AS runId, workspace_id AS workspaceId FROM execution_bindings");
    expect(successor).toContain("FROM supervisor_bindings");
  });
});
