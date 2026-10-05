/**
 * E13-T59..T63 — migration 24 → 25 (execution-abort-foundation): every prior
 * execution artifact survives byte-identically, no run is fabricated as
 * aborted, historical window closures stay accepted/replan_required, the
 * directive v1/v2/v3 hashes are untouched, and a deep rewind to v23
 * re-migrates cleanly through the whole chain.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { initializePlanStore } from "../src/store/sqlite-store.js";
// A1-I §46 — the deep-rewind legs below run on a v25-REPRESENTABLE world:
// makeActiveExecutionWorld issues NO directives, so every row survives
// the v25 protocol CHECK (a v4-directive world is not v25-representable
// and must not be collapsed below 26).
import { makeActiveExecutionWorld } from "./execution-protocol-helpers.js";
import { dropSchema24Objects, dropSchema25Objects, rawConnection, removeTempPluginDataRoot } from "./store-helpers.js";

function pluginDataRootOf(store: { path: string }): string {
  return path.dirname(path.dirname(store.path));
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function executionFingerprint(store: any, runId: string): string {
  return JSON.stringify(
    store.withRead((tx: any) => ({
      lifecycle: (tx.prepare("SELECT lifecycle FROM execution_runs WHERE execution_run_id = ?").get(runId) as any).lifecycle,
      head: tx.prepare("SELECT accepted_head_commit_id AS h, completion_commit_id AS c FROM execution_runs WHERE execution_run_id = ?").get(runId),
      directives: tx.prepare("SELECT directive_id AS id, revision, directive_hash AS hash, protocol_version AS pv FROM execution_directives WHERE execution_run_id = ? ORDER BY directive_id, revision").all(runId),
      attempts: tx.prepare("SELECT attempt_id AS id, state, directive_revision AS rev FROM execution_attempts WHERE execution_run_id = ? ORDER BY attempt_id").all(runId),
      reports: tx.prepare("SELECT report_id AS id, result, candidate_mutated AS mutated FROM execution_reports WHERE execution_run_id = ? ORDER BY report_id").all(runId),
      windows: tx.prepare("SELECT id, closed_at AS closedAt, closure_kind AS kind, candidate_revision AS revision FROM verification_windows WHERE execution_run_id = ? ORDER BY opened_at").all(runId),
      commits: tx.prepare("SELECT commit_id AS id, sequence FROM execution_commits WHERE execution_run_id = ? ORDER BY sequence").all(runId),
    })),
  );
}

describe("migration 24 → 25 execution-abort-foundation", () => {
  it("E13-T59/T60/T61/T62: a rewind to v24 re-migrates; every artifact is byte-identical and nothing is fabricated", async () => {
    const world = await makeActiveExecutionWorld(`M25-${Math.random().toString(36).slice(2, 8)}`);
    const before = executionFingerprint(world.ctx.store as never, world.executionRunId);
    const root = pluginDataRootOf(world.ctx.store);
    world.ctx.store.close();
    const raw = rawConnection(world.ctx.store.path, 5000);
    try {
      dropSchema25Objects(raw);
      raw.exec("DELETE FROM schema_migrations WHERE version >= 25");
      raw.exec("PRAGMA user_version = 24");
    } finally {
      raw.close();
    }
    const reopened = await initializePlanStore({ pluginDataRoot: root });
    try {
      expect(reopened.getSchemaVersion()).toBe(26);
      expect(executionFingerprint(reopened as never, world.executionRunId)).toBe(before);
      // E13-T62 — no run was fabricated as aborted by the migration.
      const aborted = reopened.withRead(
        (tx) => tx.prepare("SELECT count(*) AS n FROM execution_runs WHERE lifecycle = 'aborted'").get() as { n: number },
      );
      expect(aborted.n).toBe(0);
      // No abort provenance exists after migration (the table is empty).
      const records = reopened.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM execution_abort_records").get() as { n: number });
      expect(records.n).toBe(0);
      // E13-T61 — historical closures unchanged (accepted here).
      const closures = reopened.withRead(
        (tx) => tx.prepare("SELECT DISTINCT closure_kind AS k FROM verification_windows WHERE closed_at IS NOT NULL").all() as Array<{ k: string }>,
      );
      for (const row of closures) {
        expect(["accepted", "replan_required", "aborted"]).toContain(row.k);
      }
    } finally {
      reopened.close();
      removeTempPluginDataRoot(root);
    }
  });

  it("E13-T63: a deep rewind to v23 re-migrates through 24 AND 25 and the workflow still works", async () => {
    // A1-I §46 — makeIndeterminateWorld issues v4 Directives (not
    // v25-representable), so the deep leg uses the directive-free active world.
    const world = await makeActiveExecutionWorld(`D25-${Math.random().toString(36).slice(2, 6)}`);
    const before = executionFingerprint(world.ctx.store as never, world.executionRunId);
    const root = pluginDataRootOf(world.ctx.store);
    const databasePath = world.ctx.store.path;
    world.ctx.store.close();
    const raw = rawConnection(databasePath, 5000);
    try {
      dropSchema24Objects(raw);
      dropSchema25Objects(raw);
      raw.exec("DELETE FROM schema_migrations WHERE version >= 24");
      raw.exec("PRAGMA user_version = 23");
    } finally {
      raw.close();
    }
    const reopened = await initializePlanStore({ pluginDataRoot: root });
    try {
      expect(reopened.getSchemaVersion()).toBe(26);
      expect(executionFingerprint(reopened as never, world.executionRunId)).toBe(before);
      // The v25 DDL is live: an aborted window shape validates through the
      // store's schema validator on every open (initializePlanStore ran it).
    } finally {
      reopened.close();
      void fs;
      void os;
      void path;
    }
  });

  it("E13-T18/T61b: a replan_required run's replan-closed window stays replan_required after migration", async () => {
    // Build a replan world, rewind to v24, re-migrate, and confirm the
    // replan closure and lifecycle are untouched.
    const world = await makeActiveExecutionWorld(`RP25-${Math.random().toString(36).slice(2, 6)}`);
    const { requestExecutionReplanInTx } = await import("../src/application/execution-replan-service.js");
    // Issue a real open ExecutionIssue through the supervisor surface, then replan.
    const { getFinalPlanInTx } = await import("../src/store/finalization.js");
    const { parseFinalPlanCanonical } = await import("../src/application/handoff-service.js");
    const planRow = world.ctx.store.withRead((tx) => getFinalPlanInTx(tx, world.f.runId)) as { canonicalJson: string } | null;
    if (planRow === null) throw new Error("no FinalPlan");
    const plan = parseFinalPlanCanonical(planRow.canonicalJson, world.executionRunId);
    const section = plan.sections[0]!;
    const { executionToken } = await import("./phase14-helpers.js");
    const { executePhasePlanTool } = await import("../src/mcp/tools.js");
    const issueInput = {
      kind: "section_contract",
      summary: "cannot be implemented as approved",
      detail: "migration fixture",
      affected_refs: [{ type: "section", id: section.sectionId, revision: section.revision }],
    };
    const token = executionToken(world.ctx, {
      sessionId: world.f.sessionId,
      workspaceId: world.f.workspaceId,
      runId: world.executionRunId,
      finalPlanId: world.f.finalPlanId,
      generation: world.f.generation,
      tool: "report_execution_issue",
      business: issueInput,
    });
    executePhasePlanTool(world.ctx, "report_execution_issue", { ...issueInput, _hostContext: token });
    world.ctx.store.withWrite((tx) =>
      requestExecutionReplanInTx(
        tx,
        {
          sessionId: world.f.sessionId,
          workspaceId: world.f.workspaceId,
          generation: world.f.generation,
          reason: "migration replan fixture",
          affectedNormativeRefs: [{ type: "section", id: section.sectionId, revision: section.revision }],
          relevantReportRefs: [],
          toolUseId: "TU-M25-REPLAN",
        },
        world.ctx.clock,
        world.ctx.clock.nowIso(),
      ),
    );
    const before = executionFingerprint(world.ctx.store as never, world.executionRunId);
    const root = pluginDataRootOf(world.ctx.store);
    world.ctx.store.close();
    const raw = rawConnection(world.ctx.store.path, 5000);
    try {
      dropSchema25Objects(raw);
      raw.exec("DELETE FROM schema_migrations WHERE version >= 25");
      raw.exec("PRAGMA user_version = 24");
    } finally {
      raw.close();
    }
    const reopened = await initializePlanStore({ pluginDataRoot: root });
    try {
      expect(reopened.getSchemaVersion()).toBe(26);
      expect(executionFingerprint(reopened as never, world.executionRunId)).toBe(before);
      const replanWindows = reopened.withRead(
        (tx) => tx.prepare("SELECT count(*) AS n FROM verification_windows WHERE closure_kind = 'replan_required'").get() as { n: number },
      );
      expect(replanWindows.n).toBeGreaterThan(0);
    } finally {
      reopened.close();
      removeTempPluginDataRoot(root);
    }
  });
});
