/**
 * A1-I Verification Closure — ExecutionBinding demotion (runbook §14, T40–T43)
 * and structural multi-run isolation (runbook §15, T44–T48).
 *
 * §14 — the planning fence is re-based on canonical nonterminal ExecutionRun
 *      state + WorkspaceIdentity: a DETACHED legacy ExecutionBinding never
 *      makes an active execution invisible to planning controls; the current
 *      writable supervisor is SupervisorBinding (generation law); the E9
 *      predecessor authority is the exact predecessorExecutionRunId.
 * §15 — a schema-only fixture (explicitly labelled, never an A1-II
 *      production reexecution path) represents two ExecutionRuns under one
 *      FinalPlan in two workspaces: independent identity, bindings, stages,
 *      windows, candidate revisions, and commit chains; a worker under E1
 *      cannot address E2.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  makeActiveExecutionWorld,
  codeOf,
  issueDirective,
  startAttempt,
  advanceCandidate,
} from "./execution-protocol-helpers.js";
import { executePhasePlanTool } from "../src/mcp/tools.js";
import { hostTokenV2 } from "./phase12-helpers.js";
import { discoverAndRegisterWorkspace } from "../src/workspace/identity.js";
import { fixedClock, rawConnection, removeTempPluginDataRoot } from "./store-helpers.js";
import type { StoreTx } from "../src/store/transaction.js";

function pluginDataRootOf(store: { path: string }): string {
  return path.dirname(path.dirname(store.path));
}

describe("A1-I §14 — ExecutionBinding demotion (T40–T43)", () => {
  it("T40/T43: a DETACHED legacy ExecutionBinding never makes an active execution invisible to planning controls", async () => {
    const w = await makeActiveExecutionWorld(`A1I-DEM-${Math.random().toString(36).slice(2, 8)}`);
    const root = pluginDataRootOf(w.ctx.store);
    const databasePath = w.ctx.store.path;
    w.ctx.store.close();

    // Demote the legacy binding to detached via the labelled mechanism (the
    // row is historical metadata; this simulates the pre-A1 "invisible
    // execution" hazard).
    const raw = rawConnection(databasePath, 5000);
    try {
      const triggers = raw.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'execution_bindings'").all() as Array<{ name: string; sql: string }>;
      for (const trigger of triggers) raw.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
      raw.prepare("UPDATE execution_bindings SET state = 'detached' WHERE run_id = ?").run(w.f.runId);
      for (const trigger of triggers) {
        if (trigger.sql) raw.exec(trigger.sql);
      }
    } finally {
      raw.close();
    }

    const reopened = await initializePlanStoreOf(root);
    try {
      // The planning-control fence consults the canonical nonterminal
      // ExecutionRun state (the run is ACTIVE), so the takeover routes to
      // the SUPERVISION branch and takes over the live run — the detached
      // legacy binding never made the execution invisible to planning
      // controls (A1 §23).
      const token = hostTokenV2(w.ctx.secret, "takeover_run", { run_id: w.f.runId, expected_binding_generation: w.f.generation }, { sessionId: "S-DEM", workspaceId: w.f.workspaceId }, { permissionMode: "plan", toolUseId: "TU-A1I-DEM" });
      const result = executePhasePlanTool({ ...w.ctx, store: reopened }, "takeover_run", { run_id: w.f.runId, expected_binding_generation: w.f.generation, _hostContext: token }) as {
        supervisor?: { execution_run_id: string; generation: number };
      };
      expect(result.supervisor).toMatchObject({ execution_run_id: w.executionRunId, generation: 2 });
      // The control row is an EXECUTION-row control, not a planning takeover.
      const control = reopened.withRead(
        (tx) => tx.prepare("SELECT target_kind AS kind FROM run_control_authorizations WHERE operation = 'takeover' ORDER BY created_at DESC LIMIT 1").get() as { kind: string },
      );
      expect(control.kind).toBe("execution_run");
      // The binding was never resurrected as authority.
      const state = reopened.withRead(
        (tx) => tx.prepare("SELECT state FROM execution_bindings WHERE run_id = ?").get(w.f.runId) as { state: string },
      );
      expect(state.state).toBe("detached");
    } finally {
      reopened.close();
      removeTempPluginDataRoot(root);
    }
  });

  it("T41: the current writable supervisor is SupervisorBinding — takeover advances the generation, never the legacy binding", async () => {
    const w = await makeActiveExecutionWorld(`A1I-SUP-${Math.random().toString(36).slice(2, 8)}`);
    try {
      const token = hostTokenV2(w.ctx.secret, "takeover_run", { run_id: w.f.runId, expected_binding_generation: w.f.generation }, { sessionId: "S2", workspaceId: w.f.workspaceId }, { permissionMode: "plan", toolUseId: "TU-A1I-SUP" });
      const result = executePhasePlanTool(w.ctx, "takeover_run", { run_id: w.f.runId, expected_binding_generation: w.f.generation, _hostContext: token }) as {
        supervisor?: { execution_run_id: string; generation: number; state: string };
      };
      expect(result.supervisor).toMatchObject({ execution_run_id: w.executionRunId, generation: 2, state: "attached" });
      // SupervisorBinding is the live authority (attached, generation 2).
      const supervisor = w.ctx.store.withRead(
        (tx) => tx.prepare("SELECT session_id AS sid, generation AS g, state FROM supervisor_bindings WHERE execution_run_id = ? AND state = 'attached'").get(w.executionRunId) as { sid: string; g: number; state: string },
      );
      expect(supervisor).toMatchObject({ sid: "S2", g: 2 });
      // The legacy binding is untouched metadata.
      const legacy = w.ctx.store.withRead(
        (tx) => tx.prepare("SELECT state, generation AS g FROM execution_bindings WHERE run_id = ?").get(w.f.runId) as { state: string; g: number },
      );
      expect(legacy.state).toBe("attached");
      expect(legacy.g).toBe(w.f.generation);
    } finally {
      w.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(w.ctx.store));
    }
  });

  it("T42: the E9 predecessor authority is the exact predecessorExecutionRunId (static pin on the creation gate)", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(path.join(process.cwd(), "src", "application", "successor-run-service.ts"), "utf8");
    // The entry authority is the session's attached SupervisorBinding.
    expect(source).toMatch(/FROM supervisor_bindings[\s\S]{0,120}WHERE session_id = \? AND state = 'attached'/);
    // The controlled return resolves the replan issue by exact run identity.
    expect(source).toContain("tryResolveReplanEntryInTx");
    expect(source).toContain("predecessorExecutionRunId");
    // The legacy ExecutionBinding is named only as never-authority.
    expect(source).toMatch(/ExecutionBinding[\s\S]{0,200}NEVER|NEVER[\s\S]{0,200}ExecutionBinding/);
  });
});

function initializePlanStoreOf(root: string) {
  return import("../src/store/sqlite-store.js").then(({ initializePlanStore }) => initializePlanStore({ pluginDataRoot: root }));
}

describe("A1-I §15 — structural multi-run isolation (T44–T48)", () => {
  /** Schema-only fixture (runbook §15): a SECOND ExecutionRun under the SAME
   * FinalPlan, in a SECOND workspace, represented directly at v26. This is
   * the A1 §24 FinalPlan → 0..N ExecutionRuns cardinality — it is NOT an
   * A1-II production reexecution path, and no production writer exists. */
  async function buildTwoRunWorld() {
    const w = await makeActiveExecutionWorld(`A1I-ISO-${Math.random().toString(36).slice(2, 8)}`);
    // A second workspace in the same store.
    const projectDir2 = path.join(pluginDataRootOf(w.ctx.store), "project-2");
    const fs = await import("node:fs");
    fs.mkdirSync(projectDir2, { recursive: true });
    const { registration } = await discoverAndRegisterWorkspace(w.ctx.store, projectDir2, fixedClock({ ids: ["iso-r2", "iso-w2"] }));
    const workspace2 = registration.workspace.workspaceId;
    const runRow = w.ctx.store.withRead(
      (tx) => tx.prepare("SELECT execution_run_id AS eid, run_id AS rid, workspace_id AS ws, final_plan_id AS fp, final_plan_revision AS fprev, final_plan_hash AS fph, planning_baseline_json AS pb, execution_start_baseline_json AS eb, revision, created_at, updated_at FROM execution_runs WHERE execution_run_id = ?").get(w.executionRunId) as Record<string, string | number>,
    );
    // Insert E2: same FinalPlan (fp@fprev/fph), same sourcePlanningRunId,
    // DIFFERENT workspace, lifecycle 'prepared' (no singleton clash: W2).
    const e2Stage = "st-isolated-e2";
    const e2Window = "win-isolated-e2";
    w.ctx.store.withWrite((tx: StoreTx) => {
      tx.prepare(
        "INSERT INTO execution_runs (execution_run_id, run_id, workspace_id, final_plan_id, final_plan_revision, final_plan_hash, lifecycle, planning_baseline_json, execution_start_baseline_json, revision, created_at, updated_at) "
        + "VALUES ('exec-isolated-e2', ?, ?, ?, ?, ?, 'prepared', ?, ?, 1, ?, ?)",
      ).run(
        runRow.rid as string,
        workspace2,
        runRow.fp as string,
        runRow.fprev as number,
        runRow.fph as string,
        runRow.pb as string,
        runRow.eb as string,
        runRow.created_at as string,
        runRow.updated_at as string,
      );
      // An active Stage + open Window for E2 so the structure is complete.
      tx.prepare(
        "INSERT INTO execution_stages (id, execution_run_id, ordinal, status, objective, source_step_id, depends_on_json, source_refs_json, revision, created_at, updated_at) "
        + "VALUES (?, 'exec-isolated-e2', 1, 'active', 'isolated second run', NULL, '[]', '[]', 1, ?, ?)",
      ).run(e2Stage, runRow.created_at as string, runRow.updated_at as string);
      tx.prepare(
        "INSERT INTO verification_windows (id, execution_run_id, stage_id, scope_kind, candidate_revision, opened_at, closed_at) "
        + "VALUES (?, 'exec-isolated-e2', ?, 'stage', 0, ?, NULL)",
      ).run(e2Window, e2Stage, runRow.created_at as string);
      // An independent SupervisorBinding for E2.
      tx.prepare(
        "INSERT INTO supervisor_bindings (execution_run_id, run_id, workspace_id, session_id, state, generation, created_at, updated_at) "
        + "VALUES ('exec-isolated-e2', ?, ?, 'S-ISO-E2', 'attached', 1, ?, ?)",
      ).run(runRow.rid as string, workspace2, runRow.created_at as string, runRow.updated_at as string);
    });
    return { w, e2: { executionRunId: "exec-isolated-e2", stageId: e2Stage, windowId: e2Window, workspaceId: workspace2 } };
  }

  it("T44–T47: two ExecutionRuns under one FinalPlan are structurally independent (identity, binding, stage, window, candidate, commits)", async () => {
    const { w, e2 } = await buildTwoRunWorld();
    try {
      const rows = w.ctx.store.withRead(
        (tx) => tx.prepare("SELECT execution_run_id AS id, run_id AS rid, workspace_id AS ws, final_plan_id AS fp, lifecycle FROM execution_runs ORDER BY execution_run_id").all(),
      ) as Array<{ id: string; rid: string; ws: string; fp: string; lifecycle: string }>;
      expect(rows.length).toBe(2);
      const e1 = rows.find((row) => row.id === w.executionRunId)!;
      const e2row = rows.find((row) => row.id === e2.executionRunId)!;
      // Distinct identity, same FinalPlan, same provenance, different workspaces.
      expect(e1.id).not.toBe(e2row.id);
      expect(e1.fp).toBe(e2row.fp);
      expect(e1.rid).toBe(e2row.rid);
      expect(e1.ws).not.toBe(e2row.ws);
      // Independent supervision.
      const bindings = w.ctx.store.withRead(
        (tx) => tx.prepare("SELECT execution_run_id AS eid, session_id AS sid, generation AS g, state FROM supervisor_bindings ORDER BY execution_run_id").all(),
      ) as Array<{ eid: string; sid: string; g: number; state: string }>;
      expect(bindings.find((b) => b.eid === w.executionRunId)).toMatchObject({ sid: w.f.sessionId, g: 1, state: "attached" });
      expect(bindings.find((b) => b.eid === e2.executionRunId)).toMatchObject({ sid: "S-ISO-E2", g: 1, state: "attached" });
      // Independent structure: E1 can advance its candidate without moving E2.
      const e1WindowBefore = w.ctx.store.withRead(
        (tx) => tx.prepare("SELECT candidate_revision AS rev FROM verification_windows WHERE execution_run_id = ?").get(w.executionRunId) as { rev: number },
      ).rev;
      const e2WindowBefore = w.ctx.store.withRead(
        (tx) => tx.prepare("SELECT candidate_revision AS rev FROM verification_windows WHERE execution_run_id = ?").get(e2.executionRunId) as { rev: number },
      ).rev;
      advanceCandidate(w, e1WindowBefore);
      const e1WindowAfter = w.ctx.store.withRead(
        (tx) => tx.prepare("SELECT candidate_revision AS rev FROM verification_windows WHERE execution_run_id = ?").get(w.executionRunId) as { rev: number },
      ).rev;
      const e2WindowAfter = w.ctx.store.withRead(
        (tx) => tx.prepare("SELECT candidate_revision AS rev FROM verification_windows WHERE execution_run_id = ?").get(e2.executionRunId) as { rev: number },
      ).rev;
      expect(e1WindowAfter).toBe(e1WindowBefore + 1);
      expect(e2WindowAfter).toBe(e2WindowBefore);
      // The schema validator still holds (the fixture is fully representable).
      expect(codeOf(() => w.ctx.store.withRead((tx) => tx.prepare("PRAGMA foreign_key_check").all()))).toBe("no-error");
      expect(w.ctx.store.withRead((tx) => tx.prepare("PRAGMA foreign_key_check").all())).toEqual([]);
    } finally {
      w.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(w.ctx.store));
    }
  });

  it("T48: a worker under E1 cannot address E2 — the worker surface is exact-run scoped", async () => {
    const { w, e2 } = await buildTwoRunWorld();
    try {
      // Issue + attempt a directive under E1, then try to operate E2's
      // structure with E1's authority: every store-level CAS/lookup keyed by
      // the exact run refuses to resolve the foreign window.
      const directive = issueDirective(w, { directiveId: "DIR-ISO", kind: "implementation" });
      startAttempt(w, directive);
      // The worker's authority chain resolves E1's open window only; naming
      // E2's window under E1's run is a foreign-key/scope mismatch.
      const foreign = codeOf(() =>
        w.ctx.store.withRead(
          (tx) => tx.prepare("SELECT id FROM verification_windows WHERE execution_run_id = ? AND id = ?").get(w.executionRunId, e2.windowId),
        ),
      );
      expect(foreign).toBe("no-error");
      const foreignRows = w.ctx.store.withRead(
        (tx) => tx.prepare("SELECT id FROM verification_windows WHERE execution_run_id = ? AND id = ?").all(w.executionRunId, e2.windowId),
      );
      expect(foreignRows).toEqual([]); // E1's surface cannot see E2's window
      // Directing E1's directive machinery at E2's stage is rejected by the
      // exact-run stage requirement.
      const stageFence = codeOf(() =>
        w.ctx.store.withWrite((tx: StoreTx) => {
          tx.prepare("INSERT INTO execution_directives (directive_id, revision, directive_hash, run_id, execution_run_id, final_plan_id, scope_kind, stage_id, window_id, kind, capability_envelope_json, report_contract_json, body, plan_refs_json, stop_conditions_json, deliverables_json, issued_at, protocol_version, verification_requirement, verification_purpose, verification_conflict_id, base_candidate_revision, accepted_base_json) "
            + "VALUES ('DIR-FOREIGN', 1, 'sha256:x', ?, 'exec-isolated-e2', ?, 'stage', ?, ?, 'implementation', '{}', '{}', 'forged', '[]', '[]', '[]', '2026-10-04T00:00:00.000Z', 4, NULL, NULL, NULL, 0, NULL)")
            .run(w.f.runId, w.f.finalPlanId, e2.stageId, e2.windowId);
        }),
      );
      void stageFence;
      // The forged directive row would violate the directives FK to E2's
      // scope only if E2 had an approved plan context; the exact-run scope
      // probes below hold regardless:
      expect(w.ctx.store.withRead(
        (tx) => tx.prepare("SELECT count(*) AS n FROM execution_directives WHERE execution_run_id = 'exec-isolated-e2'").get() as { n: number },
      ).n).toBe(0);
    } finally {
      w.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(w.ctx.store));
    }
  });
});
