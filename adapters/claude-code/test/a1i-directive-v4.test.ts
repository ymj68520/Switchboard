/**
 * A1-I Verification Closure — Directive protocol v4 foundation
 * (runbook §9/§10/§11 — T15–T27).
 *
 * §10 — T18–T22: every fresh issuance kind (implementation, verification,
 *      inspection, conflict-resolution, reconciliation next-revision) goes
 *      out as protocol v4 through the real production issuance path, and the
 *      v4 canonical payload binds the canonical executionRunId (authority)
 *      plus the sourcePlanningRunId (provenance) — never an ambiguous runId.
 * §9  — persisted v1/v2/v3 Directive rows keep their canonical bytes and
 *      directive_hash byte-identically through the real 25 → 26 migration,
 *      with execution_run_id correctly backfilled; the frozen v1/v2/v3
 *      canonicalizer shapes are pinned (no execution identity inside them).
 * §11 — T23–T27: a real cross-migration v3 → v4 lineage bridge (DIR-X@1 v3
 *      persisted at v25, DIR-X@2 v4 issued after re-migration) preserves the
 *      exact run / FinalPlan / scope identity; the structural E2 fence and
 *      the cross-run scope fence reject foreign lineage moves; the v4→v3
 *      downgrade has zero production writers (static pin).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  makeActiveExecutionWorld,
  issueDirective,
  codeOf,
  type E4World,
} from "./execution-protocol-helpers.js";
import {
  makeAcceptanceWorld,
  runVerificationCycle,
  runDirectiveCycle,
  supervisorCall,
  currentRevision,
  type AcceptanceWorld,
} from "./acceptance-helpers.js";
import {
  makeIndeterminateWorld,
  readOnlyEnvelope,
  effectfulEnvelope,
  FULL_REPORT_CONTRACT,
  runReconciliationInspection,
} from "./attempt-recovery-helpers.js";
import { freshWorkerSession, callWorkerTool } from "./execution-worker-helpers.js";
import { startWorkerAttemptAndPrepareLaunchInTx, resolveUnreportedWorkerExitInTx } from "../src/application/worker-runtime-service.js";
import { listRunDirectivesInTx } from "../src/store/execution-directives.js";
import { getExecutionAttemptInTx } from "../src/store/execution-attempts.js";
import { discoverAndRegisterWorkspace } from "../src/workspace/identity.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import {
  canonicalDirectiveV1,
  canonicalDirectiveV2,
  canonicalDirectiveV3,
  canonicalDirectiveV4,
  executionDirectiveHash,
  type ExecutionDirective,
} from "../src/core/execution-directive.js";
import { dropSchema26Objects, fixedClock, rawConnection, removeTempPluginDataRoot, storePathsFor } from "./store-helpers.js";
import type { StoreTx } from "../src/store/transaction.js";

function pluginDataRootOf(store: { path: string }): string {
  return path.dirname(path.dirname(store.path));
}

interface StructuralSecondRun {
  executionRunId: string;
  stageId: string;
  windowId: string;
  workspaceId: string;
}

/**
 * A structurally complete SECOND ExecutionRun under the SAME FinalPlan:
 * own workspace, lifecycle active, active Stage, open Window at candidate 0,
 * attached SupervisorBinding (generation 1, session `S-<tag>`). Explicitly a
 * schema-only store-level fixture (never an A1-II production reexecution
 * path) — the world every run-local gate is proved legal in before the
 * lineage-ownership gate is isolated.
 */
async function insertStructuralSecondRun(store: E4World["ctx"]["store"], w: E4World, tag: string): Promise<StructuralSecondRun> {
  const fsMod = await import("node:fs");
  const projectDir = path.join(pluginDataRootOf(store), `project-${tag}`);
  fsMod.mkdirSync(projectDir, { recursive: true });
  const { registration } = await discoverAndRegisterWorkspace(store, projectDir, fixedClock({ ids: [`${tag}-r`, `${tag}-w`] }));
  const workspaceId = registration.workspace.workspaceId;
  const row = store.withRead(
    (tx) => tx.prepare(
      "SELECT run_id AS rid, final_plan_id AS fp, final_plan_revision AS fprev, final_plan_hash AS fph, "
      + "planning_baseline_json AS pb, execution_start_baseline_json AS eb, created_at AS ca, updated_at AS ua "
      + "FROM execution_runs WHERE execution_run_id = ?",
    ).get(w.executionRunId) as Record<string, string | number>,
  );
  const stageId = `st-${tag}`;
  const windowId = `win-${tag}`;
  store.withWrite((tx: StoreTx) => {
    tx.prepare(
      "INSERT INTO execution_runs (execution_run_id, run_id, workspace_id, final_plan_id, final_plan_revision, final_plan_hash, "
      + "lifecycle, planning_baseline_json, execution_start_baseline_json, revision, created_at, updated_at) "
      + "VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, 1, ?, ?)",
    ).run(`exec-${tag}`, row.rid as string, workspaceId, row.fp as string, row.fprev as number, row.fph as string, row.pb as string, row.eb as string, row.ca as string, row.ua as string);
    tx.prepare(
      "INSERT INTO execution_stages (id, execution_run_id, ordinal, status, objective, source_step_id, depends_on_json, source_refs_json, revision, created_at, updated_at) "
      + "VALUES (?, ?, 1, 'active', 'structural second run', NULL, '[]', '[]', 1, ?, ?)",
    ).run(stageId, `exec-${tag}`, row.ca as string, row.ua as string);
    tx.prepare(
      "INSERT INTO verification_windows (id, execution_run_id, stage_id, scope_kind, candidate_revision, opened_at, closed_at) "
      + "VALUES (?, ?, ?, 'stage', 0, ?, NULL)",
    ).run(windowId, `exec-${tag}`, stageId, row.ca as string);
    tx.prepare(
      "INSERT INTO supervisor_bindings (execution_run_id, run_id, workspace_id, session_id, state, generation, created_at, updated_at) "
      + "VALUES (?, ?, ?, ?, 'attached', 1, ?, ?)",
    ).run(`exec-${tag}`, row.rid as string, workspaceId, `S-${tag}`, row.ca as string, row.ua as string);
  });
  return { executionRunId: `exec-${tag}`, stageId, windowId, workspaceId };
}

/** The v4 canonical payload, machine-parsed from the frozen canonicalizer. */
function v4Payload(directive: ExecutionDirective): Record<string, unknown> {
  const { hash: _hash, issuedAt: _issuedAt, ...rest } = directive;
  void _hash;
  void _issuedAt;
  return JSON.parse(canonicalDirectiveV4(rest as never)) as Record<string, unknown>;
}

/** A1-I §9 labelled legacy mechanism: capture + drop the immutability
 * triggers, re-pin one revision to a frozen era via that era's canonicalizer
 * (same content, planning-scoped runId), restore the triggers byte-identically. */
function pinDirectiveEra(
  store: E4World["ctx"]["store"],
  directive: { directiveId: string; revision: number },
  era: 1 | 2 | 3,
  content: Record<string, unknown>,
): string {
  const hash = executionDirectiveHash({ ...(content as unknown as Record<string, unknown>), protocolVersion: era } as never);
  const triggers = store.withRead(
    (tx) => tx.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'execution_directives'").all() as Array<{ name: string; sql: string }>,
  );
  store.withWrite((tx: StoreTx) => {
    for (const trigger of triggers) tx.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
    // A v1-era row predates the policy columns; the fabricated-policy probe
    // reads the COLUMNS, so the pin clears them together with the era move.
    if (era === 1) {
      tx.prepare(
        "UPDATE execution_directives SET protocol_version = ?, directive_hash = ?, "
        + "verification_requirement = NULL, verification_purpose = NULL, verification_conflict_id = NULL "
        + "WHERE directive_id = ? AND revision = ?",
      ).run(era, hash, directive.directiveId, directive.revision);
    } else {
      tx.prepare("UPDATE execution_directives SET protocol_version = ?, directive_hash = ? WHERE directive_id = ? AND revision = ?").run(
        era,
        hash,
        directive.directiveId,
        directive.revision,
      );
    }
    for (const trigger of triggers) {
      if (trigger.sql) tx.exec(trigger.sql);
    }
  });
  return hash;
}

describe("A1-I §10 — T18–T22: fresh issuance is protocol v4 with canonical identity", () => {
  it("T18/T19/T20: implementation, verification, and inspection directives issue as v4 binding executionRunId + sourcePlanningRunId", async () => {
    const w = await makeActiveExecutionWorld(`A1I-V4-${Math.random().toString(36).slice(2, 8)}`);
    try {
      const implementation = issueDirective(w, { directiveId: "DIR-IMPL", kind: "implementation" });
      const verification = issueDirective(w, {
        directiveId: "DIR-VER",
        kind: "verification",
        verificationPolicy: { verificationPurpose: "normal" as const },
      });
      const inspection = issueDirective(w, { directiveId: "DIR-INS", kind: "inspection" });
      for (const directive of [implementation, verification, inspection]) {
        expect(directive.protocolVersion, directive.directiveId).toBe(4);
        const payload = v4Payload(directive);
        expect(payload.executionRunId).toBe(w.executionRunId);
        expect(payload.sourcePlanningRunId).toBe(w.f.runId);
        expect(payload).not.toHaveProperty("runId");
      }
    } finally {
      w.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(w.ctx.store));
    }
  });

  it("T21: a conflict-resolution resolver issues as v4 through the real conflict path", async () => {
    const w = await makeAcceptanceWorld(`A1I-CR-${Math.random().toString(36).slice(2, 8)}`);
    try {
      runVerificationCycle(w);
      const inspection = runDirectiveCycle(w, { directiveId: "DIR-INS-A", kind: "inspection" });
      const response = supervisorCall(w, "declare_verification_conflict", {
        fact: "the acceptance test result is disputed",
        claims: [
          { variant: "A", statement: "the acceptance test passes", source_report_ids: [w.verReportId] },
          { variant: "B", statement: "the acceptance test fails", source_report_ids: [inspection.reportId] },
        ],
      }) as { status: string; conflict: { id: string } };
      expect(response.status).toBe("declared");
      const resolver = issueDirective(w, {
        directiveId: "DIR-RESOLVE",
        kind: "verification",
        verificationPolicy: { verificationPurpose: "conflict_resolution" as const, verificationConflictId: response.conflict.id },
      });
      expect(resolver.protocolVersion).toBe(4);
      const payload = v4Payload(resolver);
      expect(payload.executionRunId).toBe(w.executionRunId);
      expect(payload.sourcePlanningRunId).toBe(w.f.runId);
    } finally {
      w.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(w.ctx.store));
    }
  });

  it("T22: the REAL E11 reconciliation path issues a v4 inspection Directive bound to the exact indeterminate Attempt — full no_effect resolution lifts the fence", async () => {
    // Required world: active ExecutionRun + side-effect-capable Attempt that
    // suffered an authoritative interruption → indeterminate, so ordinary
    // execution is fenced (E11 §13).
    const { world, attemptId } = await makeIndeterminateWorld({
      sessionId: `A1I-RC22-${Math.random().toString(36).slice(2, 8)}`,
      envelope: effectfulEnvelope() as never,
    });
    try {
      expect(world.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, attemptId))!.state).toBe("indeterminate");
      expect(codeOf(() => issueDirective(world, { directiveId: "DIR-NORMAL", kind: "implementation" }))).toBe("ATTEMPT_RECONCILIATION_REQUIRED");

      // The REAL production reconciliation issuance (E11 §11/§12): the exact
      // MCP surface a supervisor drives.
      const response = supervisorCall(world, "issue_attempt_reconciliation", {
        attempt_id: attemptId,
        objective: "Establish current repository reality for the interrupted work.",
        body: "Inspect the workspace for partial or complete effects of the interrupted Directive; report factually.",
        capability_envelope: readOnlyEnvelope(),
        report_contract: FULL_REPORT_CONTRACT,
      }) as { status: string; attempt_id: string; directive: { id: string; revision: number; hash: string; kind: string } };
      expect(response.status).toBe("reconciliation_bound");
      expect(response.attempt_id).toBe(attemptId);
      expect(response.directive.kind).toBe("inspection");

      // A1-I identity: protocolVersion = 4, canonical payload binds the exact
      // executionRunId (authority) + sourcePlanningRunId (provenance), never
      // an ambiguous runId.
      const directives = world.ctx.store.withRead((tx) => listRunDirectivesInTx(tx, world.executionRunId));
      const issued = directives.find((directive) => directive.directiveId === response.directive.id)!;
      expect(issued.protocolVersion).toBe(4);
      expect(issued.revision).toBe(1);
      const payload = v4Payload(issued);
      expect(payload.executionRunId).toBe(world.executionRunId);
      expect(payload.sourcePlanningRunId).toBe(world.f.runId);
      expect(payload).not.toHaveProperty("runId");
      // The hash covers the payload AND the requiredAction still binds the
      // EXACT indeterminate Attempt (E11 §10 option 1 — hash-covered target).
      expect(issued.requiredActions).toEqual([{ action: "reconcile_indeterminate_attempt", detail: attemptId }]);
      const { hash: _h, issuedAt: _i, ...hashRest } = issued;
      void _h;
      void _i;
      expect(executionDirectiveHash(hashRest as never)).toBe(issued.hash);
      // E11 semantics preserved: kind = inspection bound to the CURRENT open
      // window scope (stage window → that Stage), never a synthetic scope.
      expect(issued.windowId).toBe(world.openWindowId);
      expect(issued.stageId).toBe(world.activeStageId);
      const binding = world.ctx.store.withRead(
        (tx) => tx.prepare("SELECT directive_id AS id, execution_run_id AS eid FROM execution_attempt_reconciliation_bindings WHERE attempt_id = ?").get(attemptId) as { id: string; eid: string },
      );
      expect(binding).toMatchObject({ id: response.directive.id, eid: world.executionRunId });

      // Real Worker: claims the reconciliation attempt and reports a
      // non-mutating inspection (the frozen E11 revision flow of the ONE
      // bound logical Directive).
      const inspection = runReconciliationInspection(world, { attemptId });
      expect(inspection.reportId).toMatch(/^rep_/);
      expect(inspection.directiveId).toBe(response.directive.id);
      const revisionTwo = world.ctx.store.withRead(
        (tx) => tx.prepare("SELECT protocol_version AS p FROM execution_directives WHERE directive_id = ? AND revision = ?").get(response.directive.id, inspection.revision) as { p: number },
      );
      expect(revisionTwo.p).toBe(4);

      // Supervisor resolves the reconciliation — the full no_effect path.
      const before = currentRevision(world);
      const resolution = supervisorCall(world, "resolve_indeterminate_attempt", {
        attempt_id: attemptId,
        resolution: "no_effect",
        inspection_report_id: inspection.reportId,
        rationale: "the inspection found no durable effect of the interrupted work",
        expected_candidate_revision: before,
      }) as { status: string; reconciliation: { resolution: string; candidate_revision_before: number; candidate_revision_after: number } };
      expect(resolution.status).toBe("resolved");
      expect(resolution.reconciliation.resolution).toBe("no_effect");
      expect(resolution.reconciliation.candidate_revision_after).toBe(resolution.reconciliation.candidate_revision_before);
      expect(currentRevision(world)).toBe(before);
      // The Attempt itself stays indeterminate forever; the immutable
      // reconciliation is the durable resolution fact (E11 §7).
      expect(world.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, attemptId))!.state).toBe("indeterminate");
      // The v4 identity migration did not break the E11 protocol: the fence lifts.
      expect(codeOf(() => issueDirective(world, { directiveId: "DIR-AFTER", kind: "implementation" }))).toBe("no-error");
    } finally {
      world.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(world.ctx.store));
    }
  });
});

describe("A1-I §9 — persisted v1/v2/v3 Directive hash gate across the real 25 → 26 migration", () => {
  it("T15/T16/T17: three persisted era rows keep canonical bytes, hashes, and legacy run_id byte-identically; execution_run_id is backfilled", async () => {
    const w = await makeActiveExecutionWorld(`A1I-ERA-${Math.random().toString(36).slice(2, 8)}`);
    const eras: Array<{ directiveId: string; era: 1 | 2 | 3 }> = [
      { directiveId: "DIR-V1", era: 1 },
      { directiveId: "DIR-V2", era: 2 },
      { directiveId: "DIR-V3", era: 3 },
    ];
    const base = issueDirective(w, { directiveId: "DIR-V1", kind: "implementation" });
    for (const other of ["DIR-V2", "DIR-V3"]) {
      issueDirective(w, { directiveId: other, kind: "implementation" });
    }
    // Pin each row to its frozen era through the labelled legacy mechanism.
    for (const { directiveId, era } of eras) {
      const content = {
        ...base,
        directiveId,
        protocolVersion: era,
        // A v1-era row predates the verification-policy concept entirely.
        ...(era === 1 ? { verificationPolicy: null } : {}),
      };
      const { hash: _h, issuedAt: _i, ...rest } = content;
      void _h;
      void _i;
      pinDirectiveEra(w.ctx.store, { directiveId, revision: 1 }, era, rest as never);
    }
    const root = pluginDataRootOf(w.ctx.store);
    const before = w.ctx.store.withRead(
      (tx) => tx.prepare("SELECT directive_id AS id, revision, protocol_version AS protocol, directive_hash AS hash, body, run_id AS provenance FROM execution_directives ORDER BY directive_id").all(),
    ) as Array<{ id: string; revision: number; protocol: number; hash: string; body: string; provenance: string }>;
    w.ctx.store.close();

    // Real 25 → 26: rewind presents a v25 store, the reopen replays 026.
    const raw = rawConnection(storePathsFor(root).databasePath, 5000);
    try {
      dropSchema26Objects(raw);
      raw.exec("DELETE FROM schema_migrations WHERE version > 25");
      raw.exec("PRAGMA user_version = 25");
    } finally {
      raw.close();
    }
    const reopened = await initializePlanStore({ pluginDataRoot: root });
    try {
      expect(reopened.getSchemaVersion()).toBe(26);
      const after = reopened.withRead(
        (tx) => tx.prepare("SELECT directive_id AS id, revision, protocol_version AS protocol, directive_hash AS hash, body, run_id AS provenance, execution_run_id AS canonical FROM execution_directives ORDER BY directive_id").all(),
      ) as Array<{ id: string; revision: number; protocol: number; hash: string; body: string; provenance: string; canonical: string }>;
      for (const [index, row] of after.entries()) {
        const previous = before[index] as { id: string; revision: number; protocol: number; hash: string; body: string; provenance: string } | undefined;
        expect(previous, `pre-migration row ${index}`).toBeDefined();
        if (previous === undefined) continue;
        expect(row.id).toBe(previous.id);
        expect(row.protocol).toBe(previous.protocol);
        expect(row.hash).toBe(previous.hash); // byte-identical, never re-hashed
        expect(row.body).toBe(previous.body); // canonical bytes byte-identical
        expect(row.provenance).toBe(previous.provenance); // legacy run_id intact
        expect(row.canonical).toBe(w.executionRunId); // correctly backfilled
      }
    } finally {
      reopened.close();
      removeTempPluginDataRoot(root);
    }
  });

  it("T17a: the frozen v1/v2/v3 canonicalizer shapes carry no execution identity (planning-scoped era content only)", () => {
    const shape = {
      directiveId: "DIR-SHAPE",
      revision: 1,
      protocolVersion: 3 as never,
      executionRunId: "exec_should_never_appear",
      runId: "plan_era",
      finalPlanRef: { id: "fp", revision: 1, hash: "h" },
      scopeKind: "stage" as never,
      stageId: "st",
      windowId: "win",
      kind: "implementation" as never,
      capabilityEnvelope: {},
      reportContract: {},
      body: "b",
      planRefs: [],
      stopConditions: [],
      deliverables: [],
      verificationPolicy: null,
      baseCandidateRevision: 0,
    };
    for (const canonicalizer of [canonicalDirectiveV1, canonicalDirectiveV2, canonicalDirectiveV3]) {
      const payload = JSON.parse(canonicalizer(shape as never)) as Record<string, unknown>;
      expect(payload).not.toHaveProperty("executionRunId");
      expect(payload).not.toHaveProperty("sourcePlanningRunId");
    }
    // The v4 canonicalizer explicitly binds both identity fields.
    const payloadV4 = JSON.parse(canonicalDirectiveV4(shape as never)) as Record<string, unknown>;
    expect(payloadV4.executionRunId).toBe("exec_should_never_appear");
    expect(payloadV4.sourcePlanningRunId).toBe("plan_era");
  });
});

describe("A1-I §11 — T23–T27: the v3 → v4 lineage bridge and its fences", () => {
  it("T23/T24: a v3 revision persisted at v25 bridges to a v4 next revision across the real migration with identical identity", async () => {
    const w = await makeActiveExecutionWorld(`A1I-BRG-${Math.random().toString(36).slice(2, 8)}`);
    const first = issueDirective(w, { directiveId: "DIR-X", kind: "implementation" });
    // Pin @1 to the frozen v3 era (the pre-A1 persisted form) before the
    // migration: same content, v3 canonicalizer, planning-scoped runId.
    const { hash: _h, issuedAt: _i, ...firstRest } = first;
    void _h;
    void _i;
    pinDirectiveEra(w.ctx.store, { directiveId: "DIR-X", revision: 1 }, 3, firstRest as never);
    const root = pluginDataRootOf(w.ctx.store);
    w.ctx.store.close();

    const raw = rawConnection(storePathsFor(root).databasePath, 5000);
    try {
      dropSchema26Objects(raw);
      raw.exec("DELETE FROM schema_migrations WHERE version > 25");
      raw.exec("PRAGMA user_version = 25");
    } finally {
      raw.close();
    }

    const reopened = await initializePlanStore({ pluginDataRoot: root });
    const reopenedWorld: E4World = {
      ...w,
      ctx: { ...w.ctx, store: reopened },
      executionRunId: w.executionRunId,
      activeStageId: w.activeStageId,
      openWindowId: w.openWindowId,
    };
    try {
      expect(reopened.getSchemaVersion()).toBe(26);
      // The next revision through the REAL issuance service: v4 on the same
      // lineage (bridge direction v3 → v4 is the only legal forward move).
      const second = issueDirective(reopenedWorld, {
        directiveId: "DIR-X",
        kind: "implementation",
        body: "Bridged v4 revision after the v3 era and the blocked attempt.",
      });
      expect(second.protocolVersion).toBe(4);
      expect(second.directiveId).toBe("DIR-X");
      expect(second.revision).toBe(2);
      expect(second.executionRunId).toBe(w.executionRunId); // same exact ExecutionRunID
      expect(second.runId).toBe(w.f.runId); // same sourcePlanningRunId
      expect(second.finalPlanRef).toEqual(first.finalPlanRef); // same FinalPlan
      expect(second.kind).toBe(first.kind); // same Directive kind
      expect(second.stageId).toBe(first.stageId); // same Stage
      expect(second.windowId).toBe(first.windowId); // same Window
      // T24 — the lineage's protocol sequence is exactly [v3, v4].
      const lineage = reopened.withRead(
        (tx) => tx.prepare("SELECT revision AS r, protocol_version AS p FROM execution_directives WHERE directive_id = 'DIR-X' ORDER BY revision").all(),
      ) as Array<{ r: number; p: number }>;
      expect(lineage).toEqual([{ r: 1, p: 3 }, { r: 2, p: 4 }]);
      // T27 (dynamic face): every row issued post-migration is v4 — the v3
      // row survives untouched as history.
      expect(reopened.withRead(
        (tx) => tx.prepare("SELECT count(*) AS n FROM execution_directives WHERE protocol_version = 4").get() as { n: number },
      ).n).toBeGreaterThanOrEqual(1);
    } finally {
      reopened.close();
      removeTempPluginDataRoot(root);
    }
  });

  it("T25: a foreign-lineage revision fails closed at lineage OWNERSHIP — every run-local gate is independently legal (structural world)", async () => {
    const w = await makeActiveExecutionWorld(`A1I-LIN-${Math.random().toString(36).slice(2, 8)}`);
    try {
      // DIR-X@1 is created under E1 through the real issuance core.
      const first = issueDirective(w, { directiveId: "DIR-X", kind: "implementation" });
      expect(first.revision).toBe(1);
      // The structural second world: same FinalPlan F, own workspace W2,
      // lifecycle active, valid SupervisorBinding (S-E2, generation 1),
      // valid active Stage, valid open Window, valid candidate revision.
      const e2 = await insertStructuralSecondRun(w.ctx.store, w, "a1i-line2");
      const e2World: E4World = {
        ...w,
        executionRunId: e2.executionRunId,
        activeStageId: e2.stageId,
        openWindowId: e2.windowId,
        f: { ...w.f, sessionId: "S-a1i-line2", workspaceId: e2.workspaceId, generation: 1 },
      };
      // Submitting DIR-X@2 — same directive_id, next legal revision, but
      // executionRunId = E2 — with E2's valid current supervisor. The ONLY
      // illegal fact is that the DIR-X lineage belongs to E1.
      expect(codeOf(() => issueDirective(e2World, { directiveId: "DIR-X", kind: "implementation" }))).toBe("DIRECTIVE_LINEAGE_FOREIGN_RUN");
      // Negative control: the SAME authority context issues its OWN logical
      // id without any obstacle — the earlier rejection cannot be attributed
      // to a stale generation, foreign Stage, or foreign Window gate.
      const own = issueDirective(e2World, { directiveId: "DIR-E2-OWN", kind: "implementation" });
      expect(own.protocolVersion).toBe(4);
      expect(own.executionRunId).toBe(e2.executionRunId);
      expect(own.stageId).toBe(e2.stageId);
      expect(own.windowId).toBe(e2.windowId);
      // No revision @2 was persisted under E2; E1's lineage is unchanged.
      const lineage = w.ctx.store.withRead(
        (tx) => tx.prepare("SELECT execution_run_id AS eid, revision AS r FROM execution_directives WHERE directive_id = 'DIR-X' ORDER BY revision").all(),
      ) as Array<{ eid: string; r: number }>;
      expect(lineage).toEqual([{ eid: w.executionRunId, r: 1 }]);
      // E2's own directive inventory holds only its own logical id.
      const e2Directives = w.ctx.store.withRead(
        (tx) => tx.prepare("SELECT directive_id AS id FROM execution_directives WHERE execution_run_id = ?").all(e2.executionRunId) as Array<{ id: string }>,
      );
      expect(e2Directives).toEqual([{ id: "DIR-E2-OWN" }]);
      // E2 execution state unchanged: candidate revision 0, supervision
      // binding untouched (attached, generation 1).
      expect(
        w.ctx.store.withRead(
          (tx) => tx.prepare("SELECT candidate_revision AS rev FROM verification_windows WHERE id = ?").get(e2.windowId) as { rev: number },
        ).rev,
      ).toBe(0);
      expect(
        w.ctx.store.withRead(
          (tx) => tx.prepare("SELECT session_id AS sid, generation AS g, state FROM supervisor_bindings WHERE execution_run_id = ?").get(e2.executionRunId) as { sid: string; g: number; state: string },
        ),
      ).toMatchObject({ sid: "S-a1i-line2", g: 1, state: "attached" });
    } finally {
      w.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(w.ctx.store));
    }
  });

  it("A1-I closure §4: reconciliation is exact-run scoped — E2's valid supervisor cannot bind E1's indeterminate Attempt", async () => {
    // The reconciliation path always creates a DIFFERENT logical Directive
    // (dir_rec_*), so cross-run protection occurs through the target
    // Attempt's executionRunId + the issued Directive's executionRunId —
    // proved here as an exact-run mismatch rejection.
    const { world, attemptId } = await makeIndeterminateWorld({
      sessionId: `A1I-RX2-${Math.random().toString(36).slice(2, 8)}`,
      envelope: effectfulEnvelope() as never,
    });
    try {
      const e2 = await insertStructuralSecondRun(world.ctx.store, world, "a1i-recx2");
      const e2World: E4World = {
        ...world,
        executionRunId: e2.executionRunId,
        activeStageId: e2.stageId,
        openWindowId: e2.windowId,
        f: { ...world.f, sessionId: "S-a1i-recx2", workspaceId: e2.workspaceId, generation: 1 },
      };
      // E2's supervision authority is fully valid; the mismatch is ONLY the
      // attempt's owning run.
      const code = codeOf(() =>
        supervisorCall(e2World, "issue_attempt_reconciliation", {
          attempt_id: attemptId,
          objective: "Establish current repository reality for the interrupted work.",
          body: "Inspect the workspace for partial or complete effects of the interrupted Directive; report factually.",
          capability_envelope: readOnlyEnvelope(),
          report_contract: FULL_REPORT_CONTRACT,
        }),
      );
      expect(code).toBe("ATTEMPT_RECONCILIATION_TARGET_INVALID");
      // Nothing was created: no reconciliation binding for the attempt, no
      // reconciliation Directive under either run.
      expect(
        world.ctx.store.withRead(
          (tx) => tx.prepare("SELECT count(*) AS n FROM execution_attempt_reconciliation_bindings WHERE attempt_id = ?").get(attemptId) as { n: number },
        ).n,
      ).toBe(0);
      expect(
        world.ctx.store.withRead(
          (tx) => tx.prepare("SELECT count(*) AS n FROM execution_directives WHERE execution_run_id = ?").get(e2.executionRunId) as { n: number },
        ).n,
      ).toBe(0);
      // E1's attempt remains unreconciled and the ordinary-execution fence stands.
      expect(world.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, attemptId))!.state).toBe("indeterminate");
      expect(codeOf(() => issueDirective(world, { directiveId: "DIR-NORMAL", kind: "implementation" }))).toBe("ATTEMPT_RECONCILIATION_REQUIRED");
    } finally {
      world.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(world.ctx.store));
    }
  });

  it("T26/T27 (static face): the downgrade is STRUCTURALLY UNREPRESENTABLE through production issuance", () => {
    const service = fs.readFileSync(path.join(process.cwd(), "src", "application", "execution-directive-service.ts"), "utf8");
    // Every public/domain issuance path hard-selects protocolVersion = 4:
    // exactly one protocol assignment exists on the issuance path and it is
    // the v4 constant.
    const assignments = service.match(/protocolVersion:\s*\d/g) ?? [];
    expect(assignments).toEqual(["protocolVersion: 4"]);
    // No caller-controlled protocol parameter exists: the issuance input type
    // carries no protocol field at all, so no caller CAN request an era.
    const inputShape = service.match(/export interface IssueExecutionDirectiveInput[\s\S]*?\n}/)![0];
    expect(inputShape).not.toContain("protocolVersion");
    expect(service).not.toMatch(/protocolVersion\?\s*:/);
    expect(service).not.toMatch(/input\.protocolVersion/);
    // The revision service has no legal branch emitting v1/v2/v3 after
    // activation: insertExecutionDirectiveInTx is the ONLY directive INSERT,
    // and its only production caller is the canonical issuance core.
    const store = fs.readFileSync(path.join(process.cwd(), "src", "store", "execution-directives.ts"), "utf8");
    expect(store.match(/INSERT INTO execution_directives\b/g)?.length).toBe(1);
    expect(store).toContain("export function insertExecutionDirectiveInTx");
    // Canonical issuance dispatch closure — enumerate every production caller
    // of the issuance core (the reconciliation service included) and prove
    // the dispatch is closed: no second issuance path exists.
    const srcRoot = path.join(process.cwd(), "src");
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const text = fs.readFileSync(full, "utf8");
        if (text.includes("issueExecutionDirectiveInTx(")) {
          callers.push(path.relative(srcRoot, full).split(path.sep).join("/"));
        }
      }
    };
    walk(srcRoot);
    expect(callers.sort()).toEqual([
      "application/attempt-recovery-service.ts",
      "application/execution-directive-service.ts",
      "mcp/tools.ts",
    ]);
    // The frozen era list keeps v1/v2/v3 as historical, v4 as current.
    const core = fs.readFileSync(path.join(process.cwd(), "src", "core", "execution-directive.ts"), "utf8");
    expect(core).toContain("DIRECTIVE_PROTOCOL_VERSIONS = [1, 2, 3, 4]");
  });
});

describe("A1-I closure §2 — reconciliation lineage across the real 25 → 26 migration", () => {
  it("an indeterminate Attempt bound to a v3 implementation Directive keeps its exact identity through 026, and the real reconciliation path issues v4 on the same run", async () => {
    const world = await makeAcceptanceWorld(`A1I-RC2-${Math.random().toString(36).slice(2, 8)}`);
    const crash = issueDirective(world, { directiveId: "DIR-CRASH", kind: "implementation" });
    // The v25 issuance reality: @1 is a persisted v3 Directive (frozen era),
    // hash minted by the v3 canonicalizer.
    const { hash: _h0, issuedAt: _i0, ...crashRest } = crash;
    void _h0;
    void _i0;
    const v3Hash = pinDirectiveEra(world.ctx.store, { directiveId: "DIR-CRASH", revision: 1 }, 3, crashRest as never);
    // The indeterminate Attempt is built against the v3-pinned Directive
    // through the REAL E5 machinery: prepared launch → claim → authoritative
    // stop with no Report.
    const { attempt, launch } = world.ctx.store.withWrite((tx) =>
      startWorkerAttemptAndPrepareLaunchInTx(
        tx,
        {
          executionRunId: world.executionRunId,
          sessionId: world.f.sessionId,
          workspaceId: world.f.workspaceId,
          generation: world.f.generation,
          directiveId: "DIR-CRASH",
          directiveRevision: 1,
          directiveHash: v3Hash,
          workerRole: "executor",
        },
        world.ctx.clock,
        world.ctx.clock.nowIso(),
      ),
    );
    const session = freshWorkerSession(world, "RC2-CRASH");
    callWorkerTool(world, session, "worker_claim", { attempt_id: attempt.attemptId, launch_token: launch.launchToken });
    world.ctx.store.withWrite((tx) => {
      resolveUnreportedWorkerExitInTx(tx, { attemptId: attempt.attemptId }, world.ctx.clock.nowIso());
    });
    expect(world.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, attempt.attemptId))!.state).toBe("indeterminate");
    const preRunId = world.executionRunId;
    const preProvenance = world.f.runId;
    const preFinalPlan = crash.finalPlanRef;
    const root = pluginDataRootOf(world.ctx.store);
    world.ctx.store.close();

    // Real 25 → 26: rewind presents a v25 store, the reopen replays 026.
    const raw = rawConnection(storePathsFor(root).databasePath, 5000);
    try {
      dropSchema26Objects(raw);
      raw.exec("DELETE FROM schema_migrations WHERE version > 25");
      raw.exec("PRAGMA user_version = 25");
    } finally {
      raw.close();
    }
    const reopened = await initializePlanStore({ pluginDataRoot: root });
    const reopenedWorld: AcceptanceWorld = {
      ...world,
      ctx: { ...world.ctx, store: reopened },
      executionRunId: preRunId,
    };
    try {
      expect(reopened.getSchemaVersion()).toBe(26);
      // The SAME exact ExecutionRunID after backfill; provenance preserved;
      // the FinalPlan binding is untouched.
      const runRow = reopened.withRead(
        (tx) => tx.prepare("SELECT execution_run_id AS eid, run_id AS rid, final_plan_id AS fp, final_plan_revision AS fprev, final_plan_hash AS fph, lifecycle FROM execution_runs WHERE execution_run_id = ?").get(preRunId) as { eid: string; rid: string; fp: string; fprev: number; fph: string; lifecycle: string },
      );
      expect(runRow).toMatchObject({ eid: preRunId, rid: preProvenance, fp: preFinalPlan.id, fprev: preFinalPlan.revision, fph: preFinalPlan.hash });
      // The indeterminate Attempt identity survived: same id, still
      // indeterminate, still bound to the v3 Directive bytes (never re-hashed),
      // correctly backfilled to the canonical run.
      const attemptRow = reopened.withRead(
        (tx) => tx.prepare("SELECT state, directive_hash AS hash, execution_run_id AS eid FROM execution_attempts WHERE attempt_id = ?").get(attempt.attemptId) as { state: string; hash: string; eid: string },
      );
      expect(attemptRow).toMatchObject({ state: "indeterminate", hash: v3Hash, eid: preRunId });
      // NO original Report was fabricated by the migration.
      expect(
        reopened.withRead(
          (tx) => tx.prepare("SELECT count(*) AS n FROM execution_reports WHERE attempt_id = ?").get(attempt.attemptId) as { n: number },
        ).n,
      ).toBe(0);
      const crashRow = reopened.withRead(
        (tx) => tx.prepare("SELECT protocol_version AS p, directive_hash AS hash FROM execution_directives WHERE directive_id = 'DIR-CRASH' AND revision = 1").get() as { p: number; hash: string },
      );
      expect(crashRow).toMatchObject({ p: 3, hash: v3Hash });
      // The ordinary-execution fence survived the migration (E11 §13).
      expect(codeOf(() => issueDirective(reopenedWorld, { directiveId: "DIR-NORMAL", kind: "implementation" }))).toBe("ATTEMPT_RECONCILIATION_REQUIRED");

      // v26: the REAL reconciliation path issues the inspection as v4 on the
      // same run, targeting the SAME indeterminate Attempt.
      const response = supervisorCall(reopenedWorld, "issue_attempt_reconciliation", {
        attempt_id: attempt.attemptId,
        objective: "Establish current repository reality for the interrupted work.",
        body: "Inspect the workspace for partial or complete effects of the interrupted Directive; report factually.",
        capability_envelope: readOnlyEnvelope(),
        report_contract: FULL_REPORT_CONTRACT,
      }) as { status: string; directive: { id: string; revision: number } };
      expect(response.status).toBe("reconciliation_bound");
      const recDirectives = reopened.withRead((tx) => listRunDirectivesInTx(tx, preRunId));
      const issued = recDirectives.find((directive) => directive.directiveId === response.directive.id)!;
      expect(issued.protocolVersion).toBe(4);
      expect(issued.executionRunId).toBe(preRunId); // same exact ExecutionRunID
      expect(issued.runId).toBe(preProvenance); // sourcePlanningRunId preserved
      expect(issued.finalPlanRef).toEqual(preFinalPlan); // reconciliation target hash-covered via the frozen FinalPlan ref
      expect(issued.requiredActions).toEqual([{ action: "reconcile_indeterminate_attempt", detail: attempt.attemptId }]);
      const payload = v4Payload(issued);
      expect(payload.executionRunId).toBe(preRunId);
      expect(payload.sourcePlanningRunId).toBe(preProvenance);

      // Full path closure: real worker inspection → no_effect resolution →
      // the fence lifts.
      const inspection = runReconciliationInspection(reopenedWorld, { attemptId: attempt.attemptId });
      const resolution = supervisorCall(reopenedWorld, "resolve_indeterminate_attempt", {
        attempt_id: attempt.attemptId,
        resolution: "no_effect",
        inspection_report_id: inspection.reportId,
        rationale: "the inspection found no durable effect of the interrupted work",
        expected_candidate_revision: currentRevision(reopenedWorld),
      }) as { status: string };
      expect(resolution.status).toBe("resolved");
      expect(codeOf(() => issueDirective(reopenedWorld, { directiveId: "DIR-AFTER", kind: "implementation" }))).toBe("no-error");
    } finally {
      reopened.close();
      removeTempPluginDataRoot(root);
    }
  });
});
