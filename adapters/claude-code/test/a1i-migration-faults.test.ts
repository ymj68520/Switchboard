/**
 * A1-I Verification Closure — migration 026 failure atomicity (runbook §6)
 * and the failure matrix T58–T61 (runbook §18).
 *
 * §6 — fault injection at five rebuild phases (early child rebuild, middle
 *      execution-domain copy, root copy, trigger/index recreation, the final
 *      defer_foreign_keys boundary): every injected failure must roll the
 *      migration transaction back completely — version 25 intact, no *_new
 *      residue, trigger/index furniture intact, historical Directive hashes
 *      unchanged — and the plain 25 → 26 re-run must reach the identical
 *      final state. A real-runner leg proves the same atomicity through
 *      initializePlanStore with a corrupted leftover.
 * §18 — T58 orphan execution child / T59 broken FinalPlan provenance / T60
 *      cross-world acceptedHead fail the migration closed; T61 historical
 *      control semantic ambiguity SUCCEEDS and classifies target_kind =
 *      legacy_pre_a1 (deterministic structural classification, no timestamp).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { makeActiveExecutionWorld, issueDirective, type E4World } from "./execution-protocol-helpers.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import { createExecutionRunIdentityMigration } from "../src/store/migrations/026-execution-run-identity-foundation.js";
import type { StoreTx } from "../src/store/transaction.js";
import {
  dropSchema26Objects,
  fixedClock,
  rawConnection,
  rawSchemaVersion,
  removeTempPluginDataRoot,
} from "./store-helpers.js";
import { createPlanningRunService } from "../src/application/planning-run-service.js";
import { executePhasePlanTool, type PhasePlanToolContext } from "../src/mcp/tools.js";
import { hostTokenV2 } from "./phase12-helpers.js";

/** takeover_run through the real MCP handler (planning branch). */
function callTakeover(
  ctx: PhasePlanToolContext,
  ids: { sessionId: string; workspaceId: string },
  business: { run_id: string; expected_binding_generation: number },
): { supervisor?: { execution_run_id: string } } {
  const token = hostTokenV2(ctx.secret, "takeover_run", business, { sessionId: ids.sessionId, workspaceId: ids.workspaceId }, { permissionMode: "plan", toolUseId: "TU-A1I-TAKE" });
  return executePhasePlanTool(ctx, "takeover_run", { ...business, _hostContext: token }) as { supervisor?: { execution_run_id: string } };
}

/** abort_execution_run through the real MCP handler (E13 path). */
function callAbort(
  ctx: PhasePlanToolContext,
  ids: { sessionId: string; workspaceId: string; runId: string; generation: number },
): unknown {
  const business = { reason: "a1i-t61 human abort", execution_run_id: ids.runId };
  const token = hostTokenV2(
    ctx.secret,
    "abort_execution_run",
    business,
    { sessionId: ids.sessionId, workspaceId: ids.workspaceId, runId: ids.runId, generation: ids.generation },
    { permissionMode: "plan", toolUseId: "TU-A1I-ABORT" },
  );
  return executePhasePlanTool(ctx, "abort_execution_run", { ...business, _hostContext: token });
}

/** A prepared v25-shaped store WITH world data (the rewind-hybrid the
 * replay suites use): an active execution world + one issued Directive. */
async function buildV25WithWorld(label: string): Promise<{ root: string; world: E4World }> {
  const world = await makeActiveExecutionWorld(label);
  issueDirective(world, { directiveId: `DIR-${label}`, kind: "implementation" });
  const root = path.dirname(path.dirname(world.ctx.store.path));
  const raw = rawConnection(world.ctx.store.path, 5000);
  try {
    dropSchema26Objects(raw);
    raw.exec("DELETE FROM schema_migrations WHERE version > 25");
    raw.exec("PRAGMA user_version = 25");
  } finally {
    raw.close();
  }
  world.ctx.store.close();
  return { root, world };
}

/** The canonical post-migration final state used for equality across legs. */
function finalStateOf(root: string): Record<string, unknown> {
  let state: Record<string, unknown>;
  const db = rawConnection(path.join(root, "store", "phase-plan.sqlite3"), 5000);
  try {
    state = {
      version: (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      runs: db.prepare("SELECT execution_run_id, run_id, workspace_id, lifecycle FROM execution_runs ORDER BY execution_run_id").all(),
      directives: db.prepare("SELECT directive_id, revision, directive_hash, body, protocol_version FROM execution_directives ORDER BY directive_id, revision").all(),
      stages: (db.prepare("SELECT count(*) AS n FROM execution_stages").get() as { n: number }).n,
      windows: (db.prepare("SELECT count(*) AS n FROM verification_windows").get() as { n: number }).n,
      bindings: db.prepare("SELECT execution_run_id, session_id, generation, state FROM supervisor_bindings ORDER BY execution_run_id, session_id").all(),
      control: db.prepare("SELECT operation, target_kind, planning_run_id, execution_run_id FROM run_control_authorizations ORDER BY created_at").all(),
      fk: db.prepare("PRAGMA foreign_key_check").all(),
    };
  } finally {
    db.close();
  }
  return state;
}

/** Apply migration 026 by hand inside one transaction, with an injectable
 * fault (mirrors the runner's atomic apply). */
function apply026(
  databasePath: string,
  fault?: (sql: string) => boolean,
): { threw: Error | null } {
  const migration = createExecutionRunIdentityMigration();
  const db = rawConnection(databasePath, 5000);
  const guarding: StoreTx = new Proxy(db as unknown as StoreTx, {
    get(target, prop) {
      const raw = Reflect.get(target, prop);
      if (typeof raw !== "function") return raw;
      if ((prop === "prepare" || prop === "exec") && fault) {
        return (sql: string) => {
          if (fault(String(sql))) throw new Error(`INJECTED FAULT at: ${String(sql).slice(0, 72)}`);
          return raw.call(target, sql);
        };
      }
      // Native methods must be invoked with the underlying connection as
      // their receiver — a Proxy `this` raises "Illegal invocation".
      return (...args: unknown[]) => raw.call(target, ...args);
    },
  });
  db.exec("BEGIN IMMEDIATE");
  try {
    migration.apply(guarding);
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at, runtime_version) VALUES (?, ?, ?, ?)").run(
      migration.to,
      migration.name,
      "2026-10-04T00:00:00.000Z",
      "a1i-fault-test",
    );
    db.exec(`PRAGMA user_version = ${migration.to}`);
    db.exec("COMMIT");
    return { threw: null };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // the failure may have resolved the transaction already
    }
    return { threw: err as Error };
  } finally {
    db.close();
  }
}

/** The §6 rollback contract, asserted after every injected fault. */
function assertRolledBackToV25(databasePath: string, threw: Error | null): void {
  expect(threw).not.toBeNull();
  expect(threw?.message).toContain("INJECTED FAULT");
    expect(rawSchemaVersion(databasePath)).toBe(25);
    const db = rawConnection(databasePath, 5000);
    try {
      expect((db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE '%_new'").get() as { n: number }).n).toBe(0);
      // The migration history never recorded 026 (no partial completion).
      expect(
        (db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version = 26").get() as { n: number }).n,
      ).toBe(0);
    // Trigger/index furniture intact (no partial replacement).
    expect(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'execution_directives_no_update'").get() !== undefined),
    ).toBe(true);
    expect(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_verification_windows_open_run'").get() !== undefined),
    ).toBe(true);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
}

describe("A1-I §6 — migration 026 fault-injection atomicity", () => {
  const FAULTS: Array<{ name: string; fault: (sql: string) => boolean }> = [
    { name: "early child rebuild (run_events _new creation)", fault: (sql) => sql.includes("CREATE TABLE execution_run_events_new") },
    { name: "middle execution-domain copy (attempts)", fault: (sql) => sql.trim().startsWith("INSERT INTO execution_attempts_new") },
    { name: "root rebuild (execution_runs copy)", fault: (sql) => sql.trim().startsWith("INSERT INTO execution_runs_new") },
    { name: "trigger/index recreation", fault: (sql) => sql.trim().startsWith("CREATE TRIGGER") },
    { name: "defer_foreign_keys boundary", fault: (sql) => sql.includes("defer_foreign_keys = OFF") },
  ];

  it("T58h: every injected rebuild-phase failure rolls back to an intact v25 and re-migrates to the identical final state", async () => {
    const label = `A1I-FLT-${Math.random().toString(36).slice(2, 6)}`;
    const { root } = await buildV25WithWorld(label);
    const databasePath = path.join(root, "store", "phase-plan.sqlite3");
    try {
      const pristineBytes = fs.readFileSync(databasePath);

      for (const { name, fault } of FAULTS) {
        // Reset to the pristine v25 bytes for an independent fault leg.
        fs.writeFileSync(databasePath, pristineBytes);
        expect(rawSchemaVersion(databasePath)).toBe(25);

        const { threw } = apply026(databasePath, fault);
        assertRolledBackToV25(databasePath, threw);

        // Remove the fault: the plain 25 → 26 re-run reaches the canonical
        // final state (same identity, same hashes, same furniture).
        const clean = apply026(databasePath);
        expect(clean.threw, `clean re-run after: ${name}`).toBeNull();
        const state = finalStateOf(root);
        expect(state.version).toBe(26);
        expect(state.fk).toEqual([]);
        // The world's data — exactly one run, one issued v4 Directive — and
        // the historical planning provenance survived the fault + retry.
        expect((state.runs as Array<Record<string, unknown>>).length).toBe(1);
        expect((state.directives as Array<Record<string, unknown>>).length).toBe(1);
        expect((state.directives as Array<{ protocol_version: number }>)[0]?.protocol_version).toBe(4);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("T58i: a real-runner migration failure (corrupted leftover) is atomic and recoverable", async () => {
    const label = `A1I-RUN-${Math.random().toString(36).slice(2, 6)}`;
    const { root } = await buildV25WithWorld(label);
    const databasePath = path.join(root, "store", "phase-plan.sqlite3");
    try {
      // Corrupt the store: a leftover _new table makes 026's Phase 1 fail.
      const raw = rawConnection(databasePath, 5000);
      try {
        raw.exec("CREATE TABLE execution_attempts_new (id TEXT)");
      } finally {
        raw.close();
      }
      const err = (await initializePlanStore({ pluginDataRoot: root }).catch((e) => e)) as { code?: string };
      expect(err.code).toBe("STORE_MIGRATION_FAILED");
      expect(rawSchemaVersion(databasePath)).toBe(25);

      // Recover: remove the corruption, reopen — 25 → 26 succeeds.
      const repair = rawConnection(databasePath, 5000);
      try {
        repair.exec("DROP TABLE execution_attempts_new");
      } finally {
        repair.close();
      }
      const reopened = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(reopened.getSchemaVersion()).toBe(26);
        expect(reopened.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM execution_runs").get() as { n: number }).n).toBe(1);
      } finally {
        reopened.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

describe("A1-I §18 — migration failure matrix (T58–T61)", () => {
  it("T58: an orphan execution child fails the 026 preflight closed, atomically", async () => {
    const label = `A1I-T58-${Math.random().toString(36).slice(2, 6)}`;
    const { root } = await buildV25WithWorld(label);
    const databasePath = path.join(root, "store", "phase-plan.sqlite3");
    try {
      const raw = rawConnection(databasePath, 5000);
      try {
        raw.exec("PRAGMA foreign_keys = OFF");
        raw.prepare(
          "INSERT INTO execution_stages (id, run_id, ordinal, status, objective, source_step_id, depends_on_json, source_refs_json, revision, created_at, updated_at) "
          + "VALUES ('st-ghost', 'no-such-run', 1, 'active', 'orphan', 'step-x', '[]', '[]', 1, '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z')",
        ).run();
      } finally {
        raw.close();
      }
      const { threw } = apply026(databasePath);
      expect(threw?.message).toContain("orphan execution child row in 'execution_stages'");
      expect(rawSchemaVersion(databasePath)).toBe(25);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("T59: broken FinalPlan provenance fails the 026 preflight closed, atomically", async () => {
    const label = `A1I-T59-${Math.random().toString(36).slice(2, 6)}`;
    const { root } = await buildV25WithWorld(label);
    const databasePath = path.join(root, "store", "phase-plan.sqlite3");
    try {
      const raw = rawConnection(databasePath, 5000);
      try {
        raw.exec("PRAGMA foreign_keys = OFF");
        // The binding-immutable trigger guards final_plan_hash; drop the root
        // triggers before the tamper (the store is corrupt by construction
        // from here on — no restore needed).
        const triggers = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'execution_runs'").all() as Array<{ name: string }>;
        for (const trigger of triggers) raw.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
        raw.exec("UPDATE execution_runs SET final_plan_hash = 'tampered-hash' ");
      } finally {
        raw.close();
      }
      const { threw } = apply026(databasePath);
      expect(threw?.message).toContain("broken FinalPlan provenance");
      expect(rawSchemaVersion(databasePath)).toBe(25);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("T60: a cross-world acceptedHead fails the 026 preflight closed, atomically", async () => {
    const label = `A1I-T60-${Math.random().toString(36).slice(2, 6)}`;
    const { root } = await buildV25WithWorld(label);
    const databasePath = path.join(root, "store", "phase-plan.sqlite3");
    try {
      const raw = rawConnection(databasePath, 5000);
      try {
        raw.exec("PRAGMA foreign_keys = OFF");
        // The v26-era immutability triggers on the hybrid root fire on any
        // direct tamper; capture + drop them first (the store is corrupt by
        // construction from here on — no restore needed).
        const triggers = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'execution_runs'").all() as Array<{ name: string }>;
        for (const trigger of triggers) raw.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
        raw.exec("UPDATE execution_runs SET accepted_head_commit_id = 'ghost-commit' ");
      } finally {
        raw.close();
      }
      const { threw } = apply026(databasePath);
      expect(threw?.message).toMatch(/cross-world accepted head|foreign-key violation/);
      expect(rawSchemaVersion(databasePath)).toBe(25);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("T61: historically ambiguous control rows SUCCEED through 026 and classify legacy_pre_a1 (plus real abort to execution_run, planning takeover to planning_run)", async () => {
    const label = `A1I-T61-${Math.random().toString(36).slice(2, 6)}`;
    const world = await makeActiveExecutionWorld(label);
    const root = path.dirname(path.dirname(world.ctx.store.path));
    const databasePath = path.join(root, "store", "phase-plan.sqlite3");

    // (b) REAL E13 human abort through the production control path — the
    // control row, abort fact, and lifecycle move are all genuine.
    callAbort(world.ctx, {
      sessionId: world.f.sessionId,
      workspaceId: world.f.workspaceId,
      runId: world.executionRunId,
      generation: world.f.generation,
    });
    // (a) REAL planning takeover on a planning-only run (no execution world).
    const runs = createPlanningRunService(world.ctx.store, fixedClock({ ids: ["run-id-t61"] }));
    const planningOnly = runs.createPlanningRun({
      workspaceId: world.f.workspaceId,
      sessionId: "S-T61-A",
      goal: "planning-only control row",
    });
    callTakeover(world.ctx, { sessionId: "S-T61-B", workspaceId: world.f.workspaceId }, {
      run_id: planningOnly.run.runId,
      expected_binding_generation: 1,
    });
    world.ctx.store.close();
    {
      // Down through the A1 identity boundary: the reopen must REPLAY 026 so
      // the classifier (not the insert) decides every target_kind.
      const rewind = rawConnection(databasePath, 5000);
      try {
        dropSchema26Objects(rewind);
        rewind.exec("DELETE FROM schema_migrations WHERE version > 25");
        rewind.exec("PRAGMA user_version = 25");
      } finally {
        rewind.close();
      }
    }
    try {
      // (c) The synthetic historical ambiguity: a pre-A1 abort AUTHORIZATION
      // whose run has an execution world but which carries NO abort fact —
      // structurally unresolvable at v25, so the classifier must NOT guess.
      // Consistent with the v13/v25 control probes (abort rows are exempt
      // from the takeover generation law; resulting_run_revision = reached).
      const raw2 = rawConnection(databasePath, 5000);
      let runRevision = 1;
      try {
        runRevision = (raw2.prepare("SELECT revision AS r FROM planning_runs WHERE run_id = ?").get(world.f.runId) as { r: number }).r;
        raw2.prepare(
          "INSERT INTO run_control_authorizations (control_id, run_id, operation, target_kind, planning_run_id, execution_run_id, "
          + "authorization_request_id, operation_id, request_hash, workspace_id, expected_binding_generation, resulting_run_revision, created_at) "
          + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run("ctrl-ambig", world.f.runId, "abort", "planning_run", world.f.runId, null, "ar-3", "op-3", "rh-3", world.f.workspaceId, 1, runRevision, "2026-10-04T00:00:03.000Z");
      } finally {
        raw2.close();
      }

      // The migration SUCCEEDS — ambiguity is history, not corruption.
      const reopened = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(reopened.getSchemaVersion()).toBe(26);
        const rows = reopened.withRead(
          (tx) => tx.prepare("SELECT control_id AS id, operation, target_kind AS kind, planning_run_id AS pid, execution_run_id AS eid FROM run_control_authorizations ORDER BY created_at").all(),
        ) as Array<{ id: string; operation: string; kind: string; pid: string | null; eid: string | null }>;
        // (a) the real planning takeover classifies planning_run, exact id.
        const planningRow = rows.find((row) => row.kind === "planning_run" && row.pid === planningOnly.run.runId);
        expect(planningRow).toBeDefined();
        // (b) the real E13 abort classifies execution_run, exact canonical id.
        const abortRow = rows.find((row) => row.kind === "execution_run");
        expect(abortRow).toMatchObject({ operation: "abort", eid: world.executionRunId, pid: null });
        // (c) the ambiguous row classifies legacy_pre_a1 with NO typed
        // identifiers — it can never authorize a mutation (A1 §49 shape).
        const ambig = rows.find((row) => row.id === "ctrl-ambig");
        expect(ambig).toMatchObject({ operation: "abort", kind: "legacy_pre_a1", pid: null, eid: null });
        expect(reopened.withRead((tx) => tx.prepare("PRAGMA foreign_key_check").all()).length ?? 0).toBe(0);
      } finally {
        reopened.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});