/**
 * A1-I Verification Closure — legacy_pre_a1 exact replay semantics
 * (closure directive §5–§9).
 *
 * The frozen rule (A1 §42/§43): a migrated `legacy_pre_a1` control row can
 * never authorize NEW mutation — but an EXACT retry of the already-committed
 * historical operation must converge idempotently on the durable outcome:
 *
 * §6 — exact retry (same operation_id + authorization_request_id + operation
 *      + request_hash + workspace identity + legacy run identity) is
 *      recognized as the SAME historical operation: zero mutation, zero
 *      generation increment, zero new authorization/lifecycle/event object,
 *      zero reinterpretation as planning/execution authority.
 * §7 — ANY identity mismatch is IDEMPOTENCY_CONFLICT (the conflict case).
 * §8 — a row that proves request identity but whose historical planning
 *      snapshot is no longer reconstructable converges on the durable control
 *      record alone (read-only), never by re-executing the mutation.
 * §9 — the static proofs stand: no production writer, no takeover/abort/
 *      reexecution authority for legacy_pre_a1.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { makeActiveExecutionWorld, type E4World } from "./execution-protocol-helpers.js";
import { createRunControlService, type LegacyHistoricalReplayResult, type RunControlResult } from "../src/application/run-control-service.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import { dropSchema26Objects, fixedClock, rawConnection, removeTempPluginDataRoot } from "./store-helpers.js";
import type { StoreTx } from "../src/store/transaction.js";

function pluginDataRootOf(store: { path: string }): string {
  return path.dirname(path.dirname(store.path));
}

interface LegacyWorld {
  root: string;
  store: E4World["ctx"]["store"];
  w: E4World;
  /** The durable control row id the migration produced. */
  controlId: string;
  /** The historical idempotency identity the migration preserved. */
  operationId: string;
}

/**
 * Build the ONLY legal legacy_pre_a1 origin: a historical pre-A1 planning
 * control row persisted at v25 in a world that ALSO holds an execution world
 * and no abort fact — the 026 structural classifier demotes it to
 * `legacy_pre_a1` (cleared typed identifiers, legacy run_id kept as
 * provenance). The store is reopened through the REAL migration.
 */
async function makeLegacyRowWorld(
  tag: string,
  options: { operation: "takeover" | "abort" },
): Promise<LegacyWorld> {
  const w = await makeActiveExecutionWorld(`A1I-LR-${tag}`);
  const root = pluginDataRootOf(w.ctx.store);
  const databasePath = w.ctx.store.path;
  const operationId = `takeover:TU-LEGACY-${tag}`;
  const raw = rawConnection(databasePath, 5000);
  try {
    dropSchema26Objects(raw);
    raw.exec("DELETE FROM schema_migrations WHERE version > 25");
    raw.exec("PRAGMA user_version = 25");
    raw.exec("PRAGMA foreign_keys = OFF");
    const revision = (raw.prepare("SELECT revision AS r FROM planning_runs WHERE run_id = ?").get(w.f.runId) as { r: number }).r;
    const resultingRunRevision = options.operation === "abort" ? revision : null;
    raw.prepare(
      "INSERT INTO run_control_authorizations (control_id, run_id, operation, target_kind, planning_run_id, execution_run_id, "
      + "authorization_request_id, operation_id, request_hash, workspace_id, expected_binding_generation, resulting_binding_generation, "
      + "previous_binding_identity, new_binding_identity, resulting_run_revision, created_at) "
      + "VALUES (?, ?, ?, 'planning_run', ?, NULL, ?, ?, ?, ?, 1, 2, ?, ?, ?, ?)",
    ).run(
      `ctrl-${tag}`,
      w.f.runId,
      options.operation,
      w.f.runId,
      "ar-legacy",
      operationId,
      "rh-legacy",
      w.f.workspaceId,
      '{"sessionId":"S-LEGACY-OLD","generation":1}',
      '{"sessionId":"S-LEGACY-OLD","generation":2}',
      resultingRunRevision,
      "2026-10-04T00:00:03.000Z",
    );
  } finally {
    raw.close();
  }
  w.ctx.store.close();
  const reopened = await initializePlanStore({ pluginDataRoot: root });
  const reopenedWorld: E4World = { ...w, ctx: { ...w.ctx, store: reopened } };
  // The classifier demoted the historical row and cleared its typed target
  // identifiers; the legacy run_id survived as provenance only.
  expect(
    reopened.withRead(
      (tx) => tx.prepare("SELECT target_kind AS k, planning_run_id AS pid, execution_run_id AS eid, run_id AS rid, operation AS op FROM run_control_authorizations WHERE control_id = ?").get(`ctrl-${tag}`) as { k: string; pid: string | null; eid: string | null; rid: string; op: string },
    ),
  ).toMatchObject({ k: "legacy_pre_a1", pid: null, eid: null, rid: w.f.runId, op: options.operation });
  return { root, store: reopened, w: reopenedWorld, controlId: `ctrl-${tag}`, operationId };
}

/** Durable state fingerprint for the zero-mutation proofs. */
function controlFingerprint(store: LegacyWorld["store"], runId: string): {
  controlRows: number;
  binding: { sessionId: string; generation: number; state: string };
  runRevision: number;
  runUpdatedAt: string;
  bindingsCount: number;
  supervisorRows: number;
} {
  return store.withRead((tx) => {
    const controlRows = (tx.prepare("SELECT count(*) AS n FROM run_control_authorizations").get() as { n: number }).n;
    const binding = tx.prepare("SELECT session_id AS sessionId, generation, state FROM session_bindings WHERE run_id = ?").get(runId) as {
      sessionId: string;
      generation: number;
      state: string;
    };
    const run = tx.prepare("SELECT revision AS r, updated_at AS ua FROM planning_runs WHERE run_id = ?").get(runId) as { r: number; ua: string };
    const bindingsCount = (tx.prepare("SELECT count(*) AS n FROM session_bindings").get() as { n: number }).n;
    const supervisorRows = (tx.prepare("SELECT count(*) AS n FROM supervisor_bindings").get() as { n: number }).n;
    return { controlRows, binding, runRevision: run.r, runUpdatedAt: run.ua, bindingsCount, supervisorRows };
  });
}

function isLegacyReplay(result: RunControlResult | LegacyHistoricalReplayResult): result is LegacyHistoricalReplayResult {
  return "legacyHistorical" in result;
}

function codeOfErr(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "no-code";
  }
}

describe("A1-I closure §6 — an exact retry of a migrated legacy_pre_a1 row converges read-only", () => {
  it("takeover: the exact retry is the SAME historical operation — zero mutation, zero new authority", async () => {
    const legacy = await makeLegacyRowWorld(`TK-${Math.random().toString(36).slice(2, 6)}`, { operation: "takeover" });
    try {
      const before = controlFingerprint(legacy.store, legacy.w.f.runId);
      const result = createRunControlService(legacy.store, fixedClock()).takeoverRun({
        runId: legacy.w.f.runId,
        workspaceId: legacy.w.f.workspaceId,
        callerSessionId: "S-REPLAY",
        expectedBindingGeneration: 1,
        authorization: {
          authorizationRequestId: "ar-legacy",
          operationId: legacy.operationId,
          requestHash: "rh-legacy",
        },
      });
      if (!isLegacyReplay(result)) throw new Error("expected a legacy historical convergence");
      expect(result.idempotent).toBe(true);
      expect(result.control.controlId).toBe(legacy.controlId);
      expect(result.control.targetKind).toBe("legacy_pre_a1");
      // The durable historical outcome is returned read-only.
      expect(result.legacyHistorical.targetKind).toBe("legacy_pre_a1");
      expect(result.legacyHistorical.resultingBindingGeneration).toBe(2);
      expect(result.legacyHistorical.planningSnapshot).not.toBeNull();
      expect(result.legacyHistorical.planningSnapshot!.run.runId).toBe(legacy.w.f.runId);
      // Zero mutation: no second authorization, no generation increment, no
      // ownership change, no run revision bump, no new binding rows.
      const after = controlFingerprint(legacy.store, legacy.w.f.runId);
      expect(after).toEqual(before);
      expect(after.binding.sessionId).not.toBe("S-REPLAY");
      // Zero reinterpretation: the durable row was never re-written as a
      // planning_run or execution_run authorization.
      const kinds = legacy.store.withRead(
        (tx) => tx.prepare("SELECT DISTINCT target_kind AS k FROM run_control_authorizations").all() as Array<{ k: string }>,
      );
      expect(kinds).toEqual([{ k: "legacy_pre_a1" }]);
    } finally {
      legacy.store.close();
      removeTempPluginDataRoot(legacy.root);
    }
  });

  it("abort: the exact retry converges on the durable abort record — no second revision, no second detach", async () => {
    const legacy = await makeLegacyRowWorld(`AB-${Math.random().toString(36).slice(2, 6)}`, { operation: "abort" });
    try {
      const before = controlFingerprint(legacy.store, legacy.w.f.runId);
      const result = createRunControlService(legacy.store, fixedClock()).abortRun({
        workspaceId: legacy.w.f.workspaceId,
        callerSessionId: legacy.w.f.sessionId,
        bindingGeneration: legacy.w.f.generation,
        authorization: {
          authorizationRequestId: "ar-legacy",
          operationId: legacy.operationId,
          requestHash: "rh-legacy",
        },
      });
      if (!isLegacyReplay(result)) throw new Error("expected a legacy historical convergence");
      expect(result.idempotent).toBe(true);
      expect(result.control.controlId).toBe(legacy.controlId);
      expect(result.legacyHistorical.resultingRunRevision).not.toBeNull();
      // Zero mutation against the durable fingerprint.
      expect(controlFingerprint(legacy.store, legacy.w.f.runId)).toEqual(before);
    } finally {
      legacy.store.close();
      removeTempPluginDataRoot(legacy.root);
    }
  });
});

describe("A1-I closure §7 — any identity mismatch is IDEMPOTENCY_CONFLICT", () => {
  it("a changed request_hash conflicts", async () => {
    const legacy = await makeLegacyRowWorld(`MM-hash-${Math.random().toString(36).slice(2, 6)}`, { operation: "takeover" });
    try {
      const before = controlFingerprint(legacy.store, legacy.w.f.runId);
      expect(
        codeOfErr(() =>
          createRunControlService(legacy.store, fixedClock()).takeoverRun({
            runId: legacy.w.f.runId,
            workspaceId: legacy.w.f.workspaceId,
            callerSessionId: "S-REPLAY",
            expectedBindingGeneration: 1,
            authorization: { authorizationRequestId: "ar-legacy", operationId: legacy.operationId, requestHash: "rh-OTHER" },
          }),
        ),
      ).toBe("IDEMPOTENCY_CONFLICT");
      expect(controlFingerprint(legacy.store, legacy.w.f.runId)).toEqual(before);
    } finally {
      legacy.store.close();
      removeTempPluginDataRoot(legacy.root);
    }
  });

  it("a changed workspace conflicts (never a silent re-authorization)", async () => {
    const legacy = await makeLegacyRowWorld(`MM-ws-${Math.random().toString(36).slice(2, 6)}`, { operation: "takeover" });
    try {
      expect(
        codeOfErr(() =>
          createRunControlService(legacy.store, fixedClock()).takeoverRun({
            runId: legacy.w.f.runId,
            workspaceId: "ws-other-workspace",
            callerSessionId: "S-REPLAY",
            expectedBindingGeneration: 1,
            authorization: { authorizationRequestId: "ar-legacy", operationId: legacy.operationId, requestHash: "rh-legacy" },
          }),
        ),
      ).toBe("IDEMPOTENCY_CONFLICT");
    } finally {
      legacy.store.close();
      removeTempPluginDataRoot(legacy.root);
    }
  });

  it("a changed operation conflicts — a legacy takeover row cannot be replayed as an abort", async () => {
    const legacy = await makeLegacyRowWorld(`MM-op-${Math.random().toString(36).slice(2, 6)}`, { operation: "takeover" });
    try {
      expect(
        codeOfErr(() =>
          createRunControlService(legacy.store, fixedClock()).abortRun({
            workspaceId: legacy.w.f.workspaceId,
            callerSessionId: legacy.w.f.sessionId,
            bindingGeneration: legacy.w.f.generation,
            authorization: { authorizationRequestId: "ar-legacy", operationId: legacy.operationId, requestHash: "rh-legacy" },
          }),
        ),
      ).toBe("IDEMPOTENCY_CONFLICT");
    } finally {
      legacy.store.close();
      removeTempPluginDataRoot(legacy.root);
    }
  });

  it("a changed authorization request identity conflicts", async () => {
    const legacy = await makeLegacyRowWorld(`MM-arid-${Math.random().toString(36).slice(2, 6)}`, { operation: "takeover" });
    try {
      expect(
        codeOfErr(() =>
          createRunControlService(legacy.store, fixedClock()).takeoverRun({
            runId: legacy.w.f.runId,
            workspaceId: legacy.w.f.workspaceId,
            callerSessionId: "S-REPLAY",
            expectedBindingGeneration: 1,
            authorization: { authorizationRequestId: "ar-OTHER", operationId: legacy.operationId, requestHash: "rh-legacy" },
          }),
        ),
      ).toBe("IDEMPOTENCY_CONFLICT");
    } finally {
      legacy.store.close();
      removeTempPluginDataRoot(legacy.root);
    }
  });

  it("a changed legacy run identity conflicts — the request hash pins the historical target", async () => {
    const legacy = await makeLegacyRowWorld(`MM-run-${Math.random().toString(36).slice(2, 6)}`, { operation: "takeover" });
    try {
      // A DIFFERENT planning run with its own workspace binding, retrying the
      // SAME operation_id: the changed request identity (hash over the new
      // target) conflicts instead of converging on the historical row.
      legacy.store.withWrite((tx: StoreTx) => {
        tx.prepare(
          "INSERT INTO planning_runs (run_id, workspace_id, lifecycle, stage, revision, goal, created_at, updated_at) "
          + "VALUES ('plan-other-legacy', ?, 'active', 'discovery', 1, 'other target', ?, ?)",
        ).run(legacy.w.f.workspaceId, "2026-10-04T00:00:09.000Z", "2026-10-04T00:00:09.000Z");
        tx.prepare(
          "INSERT INTO session_bindings (run_id, workspace_id, session_id, state, generation, created_at, updated_at) "
          + "VALUES ('plan-other-legacy', ?, 'S-OTHER', 'attached', 1, ?, ?)",
        ).run(legacy.w.f.workspaceId, "2026-10-04T00:00:09.000Z", "2026-10-04T00:00:09.000Z");
      });
      expect(
        codeOfErr(() =>
          createRunControlService(legacy.store, fixedClock()).takeoverRun({
            runId: "plan-other-legacy",
            workspaceId: legacy.w.f.workspaceId,
            callerSessionId: "S-REPLAY",
            expectedBindingGeneration: 1,
            authorization: { authorizationRequestId: "ar-legacy", operationId: legacy.operationId, requestHash: "rh-OTHER-TARGET" },
          }),
        ),
      ).toBe("IDEMPOTENCY_CONFLICT");
    } finally {
      legacy.store.close();
      removeTempPluginDataRoot(legacy.root);
    }
  });
});

describe("A1-I closure §8 — snapshot-unavailable convergence", () => {
  it("a row that proves request identity but cannot reconstruct the planning snapshot converges on the durable record alone", async () => {
    const legacy = await makeLegacyRowWorld(`S8-${Math.random().toString(36).slice(2, 6)}`, { operation: "takeover" });
    // Corrupt the historical planning snapshot: the session binding row is
    // gone, so the read-only reconstruction is impossible. The control row
    // itself still proves the request identity.
    legacy.store.withWrite((tx: StoreTx) => {
      tx.exec("PRAGMA foreign_keys = OFF");
      tx.prepare("DELETE FROM session_bindings WHERE run_id = ?").run(legacy.w.f.runId);
    });
    try {
      const before = controlFingerprint(legacy.store, legacy.w.f.runId);
      const result = createRunControlService(legacy.store, fixedClock()).takeoverRun({
        runId: legacy.w.f.runId,
        workspaceId: legacy.w.f.workspaceId,
        callerSessionId: "S-REPLAY",
        expectedBindingGeneration: 1,
        authorization: {
          authorizationRequestId: "ar-legacy",
          operationId: legacy.operationId,
          requestHash: "rh-legacy",
        },
      });
      if (!isLegacyReplay(result)) throw new Error("expected a legacy historical convergence");
      expect(result.idempotent).toBe(true);
      expect(result.control.controlId).toBe(legacy.controlId);
      // The stable read-only convergence: the historical operation is
      // recognized as the SAME operation, its durable outcome returned, and
      // the unavailable snapshot is reported instead of re-executed.
      expect(result.legacyHistorical.planningSnapshot).toBeNull();
      expect(result.legacyHistorical.resultingBindingGeneration).toBe(2);
      // Never re-executed, never re-authorized.
      expect(controlFingerprint(legacy.store, legacy.w.f.runId)).toEqual(before);
    } finally {
      legacy.store.close();
      removeTempPluginDataRoot(legacy.root);
    }
  });
});

describe("A1-I closure §9 — the legacy_pre_a1 authority wall stands (static)", () => {
  it("no production writer and no takeover/abort/reexecution authority for legacy_pre_a1", () => {
    const storeSource = fs.readFileSync(path.join(process.cwd(), "src", "store", "run-control.ts"), "utf8");
    // The insertable target vocabulary excludes legacy_pre_a1 — the pair gate
    // is the only insert path (runtime side: control-targets T32).
    expect(storeSource).toContain('export type RunControlTargetKind = "planning_run" | "execution_run" | "final_plan_execution";');
    // legacy_pre_a1 is named ONLY as the migration-only classification.
    expect(storeSource).toContain("exists ONLY as a migration classification");
    // No control service branch grants authority to a legacy row: the
    // planning arbitration converges read-only; the ownership primitives are
    // never reachable from a legacy row.
    const serviceSource = fs.readFileSync(path.join(process.cwd(), "src", "application", "run-control-service.ts"), "utf8");
    expect(serviceSource.match(/legacy_pre_a1/g)?.length).toBeGreaterThanOrEqual(3);
    expect(serviceSource).not.toMatch(/takeoverBindingInTx[\s\S]{0,200}legacy_pre_a1/);
    expect(serviceSource).not.toMatch(/legacy_pre_a1[\s\S]{0,200}takeoverBindingInTx/);
    expect(serviceSource).not.toMatch(/legacy_pre_a1[\s\S]{0,200}UPDATE planning_runs/);
    expect(serviceSource).not.toMatch(/legacy_pre_a1[\s\S]{0,200}insertControlAuthorizationInTx/);
    // The migration is the only place the classification is ever written.
    const migration = fs.readFileSync(
      path.join(process.cwd(), "src", "store", "migrations", "026-execution-run-identity-foundation.ts"),
      "utf8",
    );
    expect(migration).toContain("'legacy_pre_a1'");
  });
});
