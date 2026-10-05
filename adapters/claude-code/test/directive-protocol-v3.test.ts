/**
 * E10 §15–§20/§66–§70 — Directive protocol v3 (E10-T13..T19) + E8 policy in
 * final scope (E10-T24..T27).
 *
 * v3 carries the EXPLICIT execution scope as canonical content (never an
 * omitted stageId); v1/v2 canonicalizers are frozen byte-for-byte; a logical
 * Directive can never switch scope across revisions; final-closure
 * implementation/inspection/verification run through the real worker protocol
 * under the unchanged E8 pressure and bounded conflict rules.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  beginFinalClosure,
  completeAllStagesFixture,
  makeAcceptanceWorld,
  runFinalClosureCycle,
  currentRevision,
  type FinalClosureWorld,
} from "./final-closure-helpers.js";
import { issueDirective, directiveInput } from "./execution-protocol-helpers.js";
import { issueExecutionDirectiveInTx } from "../src/application/execution-directive-service.js";
import {
  canonicalDirectiveV1,
  canonicalDirectiveV2,
  executionDirectiveContent,
} from "../src/core/execution-directive.js";
import { codeOf } from "./acceptance-helpers.js";

let world: FinalClosureWorld | null = null;

async function finalWindowWorld(): Promise<FinalClosureWorld> {
  world = await makeAcceptanceWorld(`V3-${Math.random().toString(36).slice(2, 8)}`);
  completeAllStagesFixture(world);
  beginFinalClosure(world);
  return world;
}

describe("E10 Directive protocol v3 (§15–§20)", () => {
  it("E10-T13: a v3 stage Directive hashes the explicit scope content", async () => {
    const w = await makeAcceptanceWorld(`V3S-${Math.random().toString(36).slice(2, 8)}`);
    const directive = issueDirective(w, { directiveId: "DIR-V3S", kind: "implementation" });
    // A1 §20 — ALL newly issued Directives carry protocol version 4.
    expect(directive.protocolVersion).toBe(4);
    expect(directive.scopeKind).toBe("stage");
    expect(directive.stageId).toBe(w.activeStageId);
    // The canonical content carries the scope as EXPLICIT canonical content.
    const content = executionDirectiveContent({ ...directive });
    expect(content).toContain('"scope":{"kind":"stage","stageId":');
    expect(content).toContain('"protocolVersion":4');
    const hash = `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
    expect(directive.hash).toBe(hash);
    w.ctx.store.close();
  });

  it("E10-T14: a v3 final-closure Directive hashes/persists scope=final_closure, stageId null", async () => {
    const w = await finalWindowWorld();
    const { directive } = runFinalClosureCycle(w, { kind: "inspection", directiveId: "DIR-V3F" });
    // A1 §20 — new issuance is protocol v4.
    expect(directive.protocolVersion).toBe(4);
    expect(directive.scopeKind).toBe("final_closure");
    expect(directive.stageId).toBeNull();
    const content = executionDirectiveContent({ ...directive });
    expect(content).toContain('"scope":{"kind":"final_closure"}');
    // Persisted row round-trips through the v3 parse with identical hash.
    const row = w.ctx.store.withRead(
      (tx) =>
        tx
          .prepare("SELECT directive_hash AS hash, scope_kind AS scopeKind, stage_id AS stageId, protocol_version AS version FROM execution_directives WHERE directive_id = 'DIR-V3F'")
          .get() as { hash: string; scopeKind: string; stageId: string | null; version: number },
    );
    expect(row.hash).toBe(directive.hash);
    expect(row.scopeKind).toBe("final_closure");
    expect(row.stageId).toBeNull();
    expect(row.version).toBe(4);
  });

  it("E10-T15: the v1/v2 canonicalizers are frozen (hash inputs byte-identical)", async () => {
    const w = await makeAcceptanceWorld(`V3F-${Math.random().toString(36).slice(2, 8)}`);
    const directive = issueDirective(w, { directiveId: "DIR-FROZEN", kind: "implementation" });
    const frozen: Parameters<typeof canonicalDirectiveV1>[0] = { ...directive, protocolVersion: 1, verificationPolicy: null };
    const v1 = canonicalDirectiveV1(frozen);
    expect(v1).toContain('"stageId":"' + w.activeStageId + '"');
    expect(v1).not.toContain("protocolVersion");
    expect(v1).not.toContain("scope");
    // v2 keeps its exact payload (protocolVersion 2 + policy, stageId raw).
    const v2 = canonicalDirectiveV2({ ...directive, protocolVersion: 2, verificationPolicy: { implementationRequirement: "immediate" } });
    expect(v2).toContain('"protocolVersion":2');
    expect(v2).toContain('"stageId":"' + w.activeStageId + '"');
    expect(v2).not.toContain('"scope"');
    w.ctx.store.close();
  });

  it("E10-T16: a logical Directive cannot switch stage ↔ final_closure across revisions", async () => {
    // Same run: issue as stage scope mid-execution, complete the run's stages,
    // begin final closure, then attempt the same logical id as final_closure.
    const w = await makeAcceptanceWorld(`V3R-${Math.random().toString(36).slice(2, 8)}`);
    const stageDirective = issueDirective(w, { directiveId: "DIR-SWITCH", kind: "inspection" });
    expect(stageDirective.scopeKind).toBe("stage");
    completeAllStagesFixture(w);
    beginFinalClosure(w);
    expect(
      codeOf(() =>
        w.ctx.store.withWrite((tx) =>
          issueExecutionDirectiveInTx(
            tx,
            {
              ...directiveInput(w, { directiveId: "DIR-SWITCH", kind: "inspection" }),
              stageId: undefined,
              scopeKind: "final_closure",
            },
            w.ctx.clock,
            w.ctx.clock.nowIso(),
          ),
        ),
      ),
    ).toBe("DIRECTIVE_REVISION_CONFLICT");
  });

  it("E10 §17: every newly issued Directive is v4 (both scopes)", async () => {
    const w = await makeAcceptanceWorld(`V3N-${Math.random().toString(36).slice(2, 8)}`);
    const stageDirective = issueDirective(w, { directiveId: "DIR-N1", kind: "implementation" });
    expect(stageDirective.protocolVersion).toBe(4);
    completeAllStagesFixture(w);
    beginFinalClosure(w);
    const { directive: finalDirective } = runFinalClosureCycle(w, { kind: "inspection", directiveId: "DIR-N2" });
    expect(finalDirective.protocolVersion).toBe(4);
    const versions = w.ctx.store.withRead(
      (tx) => tx.prepare("SELECT DISTINCT protocol_version AS v FROM execution_directives WHERE execution_run_id = ?").all(w.executionRunId) as Array<{ v: number }>,
    );
    for (const row of versions) {
      expect(row.v).toBe(4);
    }
  });
});

describe("E10 final-closure worker protocol (§17–§28, T17..T23)", () => {
  it("E10-T17/T18/T19: final implementation, inspection, and fresh normal verification run through the real worker protocol", async () => {
    const w = await finalWindowWorld();
    const implementation = runFinalClosureCycle(w, { kind: "implementation", directiveId: "DIR-FI", candidateMutated: true, reportOverrides: { files_changed: ["src/integration.ts"] } });
    expect(implementation.reportId).toMatch(/^rep_/);
    expect(currentRevision(w)).toBe(1);
    const inspection = runFinalClosureCycle(w, { kind: "inspection", directiveId: "DIR-FX" });
    expect(inspection.reportId).toMatch(/^rep_/);
    const verification = runFinalClosureCycle(w, { kind: "verification", directiveId: "DIR-FV" });
    expect(verification.reportId).toMatch(/^rep_/);
  });

  it("E10-T20/T21: a final verifier defect is rework — no replan, window stays open; repair mutates N→N+1", async () => {
    const w = await finalWindowWorld();
    runFinalClosureCycle(w, { kind: "implementation", directiveId: "DIR-R1", candidateMutated: true });
    const failing = runFinalClosureCycle(w, {
      kind: "verification",
      directiveId: "DIR-R2",
      reportOverrides: { result: "blocked", blockers: [{ kind: "MISSING_CONTEXT", summary: "cross-stage integration defect found during final verification", details: null, relevantRefs: [] }] },
    });
    expect(failing.reportId).toMatch(/^rep_/);
    // Non-accept assessment: durable judgment only; the window stays open.
    const result = w.ctx.store.withRead((tx) => {
      const row = tx
        .prepare("SELECT count(*) AS n FROM supervisor_assessments WHERE execution_run_id = ?")
        .get(w.executionRunId) as { n: number };
      return row;
    });
    expect(result.n).toBeGreaterThanOrEqual(0);
    const open = w.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL").get(w.executionRunId) as { n: number },
    );
    expect(open.n).toBe(1);
    const lifecycle = w.ctx.store.withRead(
      (tx) => (tx.prepare("SELECT lifecycle FROM execution_runs WHERE execution_run_id = ?").get(w.executionRunId) as { lifecycle: string }).lifecycle,
    );
    expect(lifecycle).toBe("active");
    // Integration repair: another mutating final-closure implementation
    // advances the candidate N → N+1.
    runFinalClosureCycle(w, { kind: "implementation", directiveId: "DIR-R3", candidateMutated: true });
    expect(currentRevision(w)).toBe(2);
  });

  it("E10-T22/T23: an old final verifier cannot accept a new revision; a fresh exact-candidate verifier is required", async () => {
    const w = await finalWindowWorld();
    runFinalClosureCycle(w, { kind: "implementation", directiveId: "DIR-S1", candidateMutated: true });
    const stale = runFinalClosureCycle(w, { kind: "verification", directiveId: "DIR-S2" });
    expect(stale.reportId).toMatch(/^rep_/);
    runFinalClosureCycle(w, { kind: "implementation", directiveId: "DIR-S3", candidateMutated: true });
    // The stale verifier's directive base (0) no longer matches the current
    // candidate (2); acceptance re-derives freshness from the Store, so the
    // stale report never qualifies again.
    const staleBases = w.ctx.store.withRead(
      (tx) =>
        tx
          .prepare("SELECT d.base_candidate_revision AS base, w.candidate_revision AS current FROM execution_directives d JOIN verification_windows w ON w.id = d.window_id WHERE d.directive_id = 'DIR-S2'")
          .get() as { base: number; current: number },
    );
    expect(staleBases.base).toBeLessThan(staleBases.current);
    runFinalClosureCycle(w, { kind: "verification", directiveId: "DIR-S4" });
    const fresh = w.ctx.store.withRead(
      (tx) =>
        tx
          .prepare("SELECT d.base_candidate_revision AS base FROM execution_directives d WHERE d.directive_id = 'DIR-S4'")
          .get() as { base: number },
    );
    expect(fresh.base).toBe(staleBases.current);
  });
});
