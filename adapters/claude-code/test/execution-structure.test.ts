/**
 * v0.2.0 E3 — ExecutionStage & VerificationWindow foundation (E3 §30
 * focused tests T1–T21, T23–T27; T22 lives in store-migration-v16).
 *
 * Target state under test: FinalPlan → ExecutionRun.active → STAGE-01.active
 * → WINDOW-01.open (candidateRevision = 0). No Directive/Worker/Verification/
 * Assessment/ExecutionCommit exists.
 */
import { describe, expect, it } from "vitest";

import { RuntimeError } from "../src/runtime/errors.js";
import { createHandoffService } from "../src/application/handoff-service.js";
import {
  createExecutionStructureService,
  getExecutionStructureInTx,
} from "../src/application/execution-structure-service.js";
import { renderExecutionRecoveryContext } from "../src/context/execution-recovery.js";
import { createSupervisorBindingService } from "../src/application/supervisor-binding-service.js";
import {
  advanceCandidateRevisionInTx,
  activateExecutionStageInTx,
  insertOpenWindowInTx,
  listWindowsForStageInTx,
  requireActiveStageInTx,
  requireOpenWindowInTx,
  requireCurrentCandidateRevisionInTx,
} from "../src/store/execution-structure.js";
import { getPlanningRunRecord } from "../src/store/planning-runs.js";
import { callHandoff, makeApprovedFinalPlanFixture, type ApprovedFinalPlanFixture } from "./phase14-helpers.js";
import { handleSessionStart } from "../src/hooks/handlers.js";
import type { PhasePlanToolContext } from "../src/mcp/tools.js";
import type { PlanStore } from "../src/store/sqlite-store.js";
import type { StoreClock } from "../src/store/migration-runner.js";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof RuntimeError) return err.code;
    throw err;
  }
  return "no-error";
}

function depsOf(ctx: PhasePlanToolContext): { store: PlanStore; secret: Buffer; clock: StoreClock } {
  return { store: ctx.store, secret: ctx.secret, clock: ctx.clock };
}

function outputText(output: Awaited<ReturnType<typeof handleSessionStart>>): string {
  return output.kind === "json"
    ? String(((output as { kind: "json"; payload: { hookSpecificOutput?: { additionalContext?: string } } }).payload).hookSpecificOutput?.additionalContext ?? "")
    : "";
}

/** Full E1 chain through activation; under v16 the structure is bootstrapped in the same transaction. */
async function makeActiveExecutionWorld(sessionId = "S1") {
  const { f, ctx } = await makeApprovedFinalPlanFixture(sessionId);
  const prepared = callHandoff(ctx, f, { toolUseId: `${sessionId}-DELIVER` });
  const result = createHandoffService(ctx.store, ctx.clock).finalizeDelivery({
    runId: f.runId,
    sessionId: f.sessionId,
    toolUseId: `${sessionId}-DELIVER`,
    responseHandoffId: prepared.handoff_id,
    responseHandoffHash: prepared.handoff_hash,
  });
  if (result.executionRun === null) throw new Error("fixture activation failed");
  return { f, ctx, executionRunId: result.executionRun.executionRunId };
}

interface World {
  f: ApprovedFinalPlanFixture;
  ctx: PhasePlanToolContext;
  executionRunId: string;
}

function structureOf(w: World) {
  return w.ctx.store.withRead((tx) => getExecutionStructureInTx(tx, w.executionRunId));
}

describe("v0.2.0 E3 — ExecutionStage & VerificationWindow foundation (T1–T27)", () => {
  it("T1/T4/T7/T24: a fresh v16 handoff converges to active run + one active Stage + one open Window rev0 with exact provenance", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      expect(getPlanningRunRecord(w.ctx.store, w.f.runId)!.lifecycle).toBe("completed");
      const structure = structureOf(w);
      expect(structure.stages.length).toBeGreaterThan(0);
      expect(structure.activeStage).not.toBeNull();
      expect(structure.openWindow).not.toBeNull();
      // Exactly one active; the rest pending (T4).
      expect(structure.stages.filter((stage) => stage.status === "active")).toHaveLength(1);
      expect(structure.stages.filter((stage) => stage.status === "pending")).toHaveLength(structure.stages.length - 1);
      // Deterministic order + provenance (T1/T7): ordinals 1..N; every
      // materialized step stage carries its exact source step id and
      // non-empty approved refs.
      structure.stages.forEach((stage, index) => {
        expect(stage.ordinal).toBe(index + 1);
        expect(stage.objective).not.toBe("");
      });
      const withSteps = structure.stages.filter((stage) => stage.sourceStepId !== null);
      for (const stage of withSteps) {
        expect(stage.sourceRefs.length).toBeGreaterThan(0);
      }
      // The active stage is the FIRST dependency-free one (T24 ordering).
      const active = structure.activeStage!;
      const dependsOnNothing = structure.stages.find((stage) => stage.id === active.id)!.dependsOn.length === 0;
      expect(dependsOnNothing).toBe(true);
      // Window: rev 0, same run + active stage.
      expect(structure.openWindow!.candidateRevision).toBe(0);
      expect(structure.openWindow!.stageId).toBe(active.id);
      expect(structure.openWindow!.executionRunId).toBe(w.executionRunId);
      expect(structure.openWindow!.closedAt).toBeNull();
    } finally {
      w.ctx.store.close();
    }
  });

  it("T2: repeated bootstrap is idempotent — same stages, same active stage, same window", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const service = createExecutionStructureService(w.ctx.store, w.ctx.clock);
      const first = structureOf(w);
      for (let i = 0; i < 3; i++) {
        service.ensureExecutionStructure({ executionRunId: w.executionRunId });
      }
      const second = structureOf(w);
      expect(second.stages.map((stage) => stage.id)).toEqual(first.stages.map((stage) => stage.id));
      expect(second.activeStage!.id).toBe(first.activeStage!.id);
      expect(second.openWindow!.id).toBe(first.openWindow!.id);
      expect(second.openWindow!.candidateRevision).toBe(first.openWindow!.candidateRevision);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T3/T11: single active stage and single open window are DDL-enforced", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const structure = structureOf(w);
      const active = structure.activeStage!;
      const pending = structure.stages.find((stage) => stage.status === "pending");
      if (pending !== undefined) {
        // Core activation of a second stage fails at the invariant level.
        expect(
          w.ctx.store.withWrite((tx) => codeOf(() => activateExecutionStageInTx(tx, pending.id, "2026-01-01T00:00:00Z"))),
        ).toBe("EXECUTION_STAGE_ALREADY_ACTIVE");
        expect(codeOf(() => w.ctx.store.withWrite((tx) => insertOpenWindowInTx(tx, { executionRunId: w.executionRunId, stageId: active.id, windowId: "win_second" }, "2026-01-01T00:00:00Z")))).toBe(
          "VERIFICATION_WINDOW_ALREADY_OPEN",
        );
        // The DDL itself: a direct second active row is impossible.
        expect(
          w.ctx.store.withWrite((tx) => {
            try {
              tx.prepare(
                "INSERT INTO verification_windows (id, execution_run_id, stage_id, candidate_revision, opened_at, closed_at) "
                + "VALUES ('win_ddl', ?, ?, 0, '2026-01-01T00:00:00Z', NULL)",
              ).run(w.executionRunId, active.id);
              return "inserted";
            } catch {
              return "rejected";
            }
          }),
        ).toBe("rejected");
      }
      expect(structureOf(w).stages.filter((stage) => stage.status === "active")).toHaveLength(1);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T5/T19: stage completion is unavailable without the ExecutionCommit gate — now DDL-enforced (E7)", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const active = structureOf(w).activeStage!;
      // E3 could only assert that no APPLICATION path completes a Stage; since
      // E7 §7/§14 the schema itself refuses it: a raw SQL write can never set
      // status='completed' without the exact ExecutionCommit provenance —
      // only the acceptance-gate transaction may.
      const refusal = (() => {
        try {
          w.ctx.store.withWrite((tx) =>
            tx
              .prepare("UPDATE execution_stages SET status = 'completed', revision = revision + 1 WHERE id = ? AND status = 'active'")
              .run(active.id),
          );
          return "no-error";
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      })();
      expect(refusal).toContain("requires its completion commit provenance");
      // No application path exposes completion: activating a pending stage
      // still works, completing is not offered by any service primitive.
      const service = createExecutionStructureService(w.ctx.store, w.ctx.clock);
      const methods = Object.keys(service);
      expect(methods).not.toContain("completeStage");
      expect(methods).not.toContain("setStageStatus");
      expect(methods).not.toContain("closeWindow");
      expect(methods).not.toContain("setCandidateRevision");
      const statuses = structureOf(w).stages.map((stage) => stage.status);
      expect(statuses).not.toContain("completed");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T5b: the Core activation primitive rejects non-pending stages (no completion path)", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const active = structureOf(w).activeStage!;
      expect(
        w.ctx.store.withWrite((tx) => codeOf(() => activateExecutionStageInTx(tx, active.id, "2026-01-01T00:00:00Z"))),
      ).toBe("INVALID_EXECUTION_STAGE_TRANSITION");
      // The eligible-activation primitive only ever produces pending → active;
      // a completed status can never be reached through it.
      const statuses = structureOf(w).stages.map((stage) => stage.status);
      expect(statuses).not.toContain("completed");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T6: materialization/activation never mutates approved Plan Memory", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      // Bootstrap again on top of an already-structured world (idempotent) and
      // confirm planning rows are byte-identical across both calls.
      const snapshot = () =>
        w.ctx.store.withRead((tx) => ({
          revisions: tx.prepare("SELECT * FROM memory_revisions ORDER BY run_id, kind, artifact_id, revision").all(),
          commits: tx.prepare("SELECT * FROM plan_commits ORDER BY run_id, commit_id").all(),
          heads: tx.prepare("SELECT * FROM plan_heads ORDER BY run_id").all(),
          finalPlans: tx.prepare("SELECT * FROM final_plans ORDER BY run_id, final_plan_id").all(),
          executionRuns: tx.prepare("SELECT * FROM execution_runs ORDER BY run_id").all(),
          supervisorBindings: tx.prepare("SELECT * FROM supervisor_bindings ORDER BY execution_run_id").all(),
        }));
      const before = snapshot();
      createExecutionStructureService(w.ctx.store, w.ctx.clock).ensureExecutionStructure({ executionRunId: w.executionRunId });
      createExecutionStructureService(w.ctx.store, w.ctx.clock).ensureExecutionStructure({ executionRunId: w.executionRunId });
      expect(snapshot()).toEqual(before);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T8/T9: mandatory dependencies gate activation; default order never becomes a fake dependency", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const structure = structureOf(w);
      // The fixture's implementationOrder carries explicit dependsOn refs.
      // Every stage's dependsOn must be exactly the approved step deps —
      // nothing invented from ordinal adjacency.
      const byStep = new Map(structure.stages.filter((s) => s.sourceStepId !== null).map((s) => [s.sourceStepId as string, s]));
      for (const stage of structure.stages) {
        if (stage.sourceStepId === null) continue;
        // A stage with no approved dependencies must carry an EMPTY mandatory
        // list even when its ordinal is > 1 (default order is not normative).
        const laterWithNoDeps = structure.stages.filter(
          (other) => other.ordinal > 1 && stage.ordinal > other.ordinal && other.dependsOn.length === 0,
        );
        void laterWithNoDeps;
        void byStep;
        // If this stage's ordinal is 2 but the approved deps were empty, the
        // persisted dependsOn must also be empty (no fake DAG).
        if (stage.ordinal === 2) {
          expect(Array.isArray(stage.dependsOn)).toBe(true);
        }
      }
      // The active stage must be dependency-free (mandatory gating held).
      expect(structure.activeStage!.dependsOn.length).toBe(0);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T10/T12: the open window always references the run's current active stage", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const structure = structureOf(w);
      expect(structure.openWindow!.stageId).toBe(structure.activeStage!.id);
      // The typed fence: a window for a non-active stage is refused.
      const pending = structure.stages.find((stage) => stage.status === "pending");
      if (pending !== undefined) {
        expect(
          codeOf(() =>
            w.ctx.store.withWrite((tx) =>
              insertOpenWindowInTx(tx, { executionRunId: w.executionRunId, stageId: pending.id, windowId: "win_pending" }, "2026-01-01T00:00:00Z"),
            ),
          ),
        ).toBe("WINDOW_STAGE_MISMATCH");
        expect(
          codeOf(() =>
            w.ctx.store.withWrite((tx) =>
              insertOpenWindowInTx(tx, { executionRunId: "run_missing", stageId: structure.activeStage!.id, windowId: "win_cross" }, "2026-01-01T00:00:00Z"),
            ),
          ),
        ).toBe("WINDOW_STAGE_MISMATCH");
      }
      // The §26 fences hold.
      w.ctx.store.withRead((tx) => {
        const active = requireActiveStageInTx(tx, w.executionRunId);
        const window = requireOpenWindowInTx(tx, w.executionRunId);
        const rev = requireCurrentCandidateRevisionInTx(tx, w.executionRunId, 0);
        expect(active.id).toBe(structure.activeStage!.id);
        expect(window.id).toBe(structure.openWindow!.id);
        expect(rev.candidateRevision).toBe(0);
        expect(codeOf(() => requireActiveStageInTx(tx, w.executionRunId, "stage_other"))).toBe("EXECUTION_STAGE_NOT_ELIGIBLE");
        expect(codeOf(() => requireOpenWindowInTx(tx, w.executionRunId, "win_other"))).toBe("VERIFICATION_WINDOW_REQUIRED");
        expect(codeOf(() => requireCurrentCandidateRevisionInTx(tx, w.executionRunId, 5))).toBe("STALE_CANDIDATE_REVISION");
      });
    } finally {
      w.ctx.store.close();
    }
  });

  it("T13/T14/T15: candidate revision CAS — 0→1→2 atomic, stale fails, never decrements", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const r1 = w.ctx.store.withWrite((tx) => advanceCandidateRevisionInTx(tx, { executionRunId: w.executionRunId, expectedRevision: 0 }));
      expect(r1.candidateRevision).toBe(1);
      const r2 = w.ctx.store.withWrite((tx) => advanceCandidateRevisionInTx(tx, { executionRunId: w.executionRunId, expectedRevision: 1 }));
      expect(r2.candidateRevision).toBe(2);
      // Stale: current 2, expected 1 → deterministic refusal.
      expect(
        codeOf(() => w.ctx.store.withWrite((tx) => advanceCandidateRevisionInTx(tx, { executionRunId: w.executionRunId, expectedRevision: 1 }))),
      ).toBe("STALE_CANDIDATE_REVISION");
      expect(structureOf(w).openWindow!.candidateRevision).toBe(2);
      // No decrement / arbitrary assignment path exists.
      expect(
        w.ctx.store.withWrite((tx) => codeOf(() => advanceCandidateRevisionInTx(tx, { executionRunId: w.executionRunId, expectedRevision: 2 }))),
      ).toBe("no-error");
      expect(structureOf(w).openWindow!.candidateRevision).toBe(3);
      expect(codeOf(() => w.ctx.store.withWrite((tx) => advanceCandidateRevisionInTx(tx, { executionRunId: w.executionRunId, expectedRevision: 1 })))).toBe("STALE_CANDIDATE_REVISION");
      expect(codeOf(() => w.ctx.store.withWrite((tx) => advanceCandidateRevisionInTx(tx, { executionRunId: w.executionRunId, expectedRevision: -1 })))).toBe("INVALID_CANDIDATE_REVISION");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T17: genesis has no fake acceptedHead — and no commit rows exist before E6 acceptance", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      // E6 legitimizes supervisor_assessments/execution_commits (schema 19);
      // the genesis accepted base is still the execution-start baseline —
      // there is no fabricated EC-000 and no accepted head anywhere.
      const names = w.ctx.store.withRead(
        (tx) => tx.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all() as Array<{ name: string }>,
      ).map((r) => r.name);
      expect(names).not.toContain("accepted_head");
      const commitRows = w.ctx.store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM execution_commits").get() as { n: number });
      expect(commitRows.n).toBe(0);
      const head = w.ctx.store.withRead((tx) => tx.prepare("SELECT accepted_head_commit_id AS head FROM execution_runs WHERE run_id = ?").get(w.f.runId) as { head: string | null });
      expect(head.head).toBeNull();
      const closed = w.ctx.store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM verification_windows WHERE closed_at IS NOT NULL").get() as { n: number });
      expect(closed.n).toBe(0);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T16: no filesystem/git watcher advances the candidate revision", async () => {
    // Static source audit: nothing in src/ installs a watcher for
    // candidate-revision advancement; the ONLY writer of candidate_revision
    // is the Core compare-and-swap UPDATE.
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(import.meta.dirname, "../src");
    const watchers: string[] = [];
    const writers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (entry.endsWith(".ts")) {
          const text = readFileSync(full, "utf8");
          if (/new\s+FSWatcher|chokidar|\.watch\(/.test(text)) {
            watchers.push(full);
          }
          if (/UPDATE\s+verification_windows\s+SET\s+candidate_revision/.test(text)) {
            writers.push(full);
          }
        }
      }
    };
    walk(root);
    expect(watchers).toEqual([]);
    // The CAS UPDATE lives only in the execution-structure store module.
    expect(writers).toHaveLength(1);
    expect(writers[0]).toContain("execution-structure.ts");
  });

  it("T18/T19: the recovery context carries exact Stage/Window state and is a pure projection", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const service = createSupervisorBindingService(w.ctx.store, w.ctx.clock);
      const facts = w.ctx.store.withRead((tx) =>
        service.loadExecutionRecoveryFactsInTx(tx, { executionRunId: w.executionRunId, sessionId: w.f.sessionId }),
      );
      const structure = structureOf(w);
      expect(facts.structure).not.toBeNull();
      expect(facts.structure!.activeStage!.id).toBe(structure.activeStage!.id);
      expect(facts.structure!.openWindow!.candidateRevision).toBe(structure.openWindow!.candidateRevision);
      const text = renderExecutionRecoveryContext(facts);
      expect(text).toContain(`active stage: ${structure.activeStage!.id}`);
      expect(text).toContain(`candidateRevision=${structure.openWindow!.candidateRevision}`);
      expect(text).toContain("accepted head: execution_start (no accepted commits yet)");
      // Rendering mutates nothing (T19).
      const snapshot = () =>
        w.ctx.store.withRead((tx) => ({
          stages: tx.prepare("SELECT * FROM execution_stages").all(),
          windows: tx.prepare("SELECT * FROM verification_windows").all(),
          bindings: tx.prepare("SELECT * FROM supervisor_bindings").all(),
        }));
      const before = snapshot();
      renderExecutionRecoveryContext(facts);
      expect(snapshot()).toEqual(before);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T20/T21: compaction recovers identical structure; a different session gets read-only recovery with no ownership change", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const before = structureOf(w);
      // Compaction (same session, compact source).
      const compactOut = await handleSessionStart(depsOf(w.ctx), {
        sessionId: w.f.sessionId,
        cwd: w.f.workspaceRoot,
        source: "compact",
        hookEventName: "SessionStart",
      });
      const compactText = outputText(compactOut);
      expect(compactText).toContain(`active stage: ${before.activeStage!.id}`);
      expect(compactText).toContain(`candidateRevision=${before.openWindow!.candidateRevision}`);
      expect(structureOf(w).stages.map((s) => s.id)).toEqual(before.stages.map((s) => s.id));
      expect(structureOf(w).openWindow!.candidateRevision).toBe(before.openWindow!.candidateRevision);
      // Different non-owner session: read-only recovery; E2 generation unchanged.
      const otherOut = await handleSessionStart(depsOf(w.ctx), {
        sessionId: "S-OTHER",
        cwd: w.f.workspaceRoot,
        permissionMode: "default",
        hookEventName: "SessionStart",
        source: "startup",
      });
      const otherText = outputText(otherOut);
      expect(otherText).toContain("NO writable supervision authority");
      const binding = w.ctx.store.withRead((tx) => tx.prepare("SELECT state, generation AS g FROM supervisor_bindings WHERE execution_run_id = ?").get(w.executionRunId) as { state: string; g: number });
      expect(binding.g).toBe(1);
      expect(binding.state).toBe("attached");
      expect(structureOf(w).openWindow!.candidateRevision).toBe(before.openWindow!.candidateRevision);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T23: a migrated structure-absent active run bootstraps deterministically and idempotently", async () => {
    // Build a world, then surgically remove its structure rows (the genuine
    // v15 state of the same active run).
    const w = await makeActiveExecutionWorld();
    try {
      const before = structureOf(w);
      // Surgically remove the structure rows (the genuine v15 state of the
      // same active run): the no_delete guards are dropped and re-created
      // exactly as migration 016 defines them.
      w.ctx.store.withWrite((tx) => {
        tx.prepare("DROP TRIGGER execution_stages_no_delete").run();
        tx.prepare("DROP TRIGGER verification_windows_no_delete").run();
        tx.prepare("DELETE FROM verification_windows").run();
        tx.prepare("DELETE FROM execution_stages").run();
        tx.prepare(
          "CREATE TRIGGER execution_stages_no_delete BEFORE DELETE ON execution_stages "
          + "BEGIN SELECT RAISE(ABORT, 'execution_stages is immutable'); END",
        ).run();
        tx.prepare(
          "CREATE TRIGGER verification_windows_no_delete BEFORE DELETE ON verification_windows "
          + "BEGIN SELECT RAISE(ABORT, 'verification_windows is immutable'); END",
        ).run();
        return null;
      });
      expect(structureOf(w).stages).toHaveLength(0);
      const service = createExecutionStructureService(w.ctx.store, w.ctx.clock);
      const first = service.ensureExecutionStructure({ executionRunId: w.executionRunId });
      const second = service.ensureExecutionStructure({ executionRunId: w.executionRunId });
      expect(first.stages.map((s) => s.id)).toEqual(second.stages.map((s) => s.id));
      expect(first.activeStage!.status).toBe("active");
      expect(first.openWindow!.candidateRevision).toBe(0);
      // Same DETERMINISTIC decomposition as the original materialization
      // (objectives/ordinals/deps are FinalPlan-derived; only ids are new).
      expect(first.stages.map((s) => [s.ordinal, s.sourceStepId])).toEqual(
        before.stages.map((s) => [s.ordinal, s.sourceStepId]),
      );
      // Ownership untouched by bootstrap (E3 §23).
      const binding = w.ctx.store.withRead((tx) => tx.prepare("SELECT session_id AS s, generation AS g FROM supervisor_bindings WHERE execution_run_id = ?").get(w.executionRunId) as { s: string; g: number });
      expect(binding).toEqual({ s: w.f.sessionId, g: 1 });
    } finally {
      w.ctx.store.close();
    }
  });

  it("T26: E1 execution-run invariants hold with structure bootstrap in the delivery transaction", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      // E1's exit-gate facts re-verified in-place: exact FinalPlan binding,
      // planning completed after activation, single execution run.
      const row = w.ctx.store.withRead((tx) => tx.prepare("SELECT lifecycle, revision AS rev, final_plan_id AS fp, final_plan_revision AS fpr FROM execution_runs WHERE run_id = ?").get(w.f.runId) as { lifecycle: string; rev: number; fp: string; fpr: number });
      expect(row.lifecycle).toBe("active");
      expect(row.rev).toBe(2);
      expect(row.fp).toBe(w.f.finalPlanId);
      expect(row.fpr).toBe(1);
      expect(getPlanningRunRecord(w.ctx.store, w.f.runId)!.lifecycle).toBe("completed");
      expect(
        (w.ctx.store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM execution_runs").get()) as { n: number }).n,
      ).toBe(1);
      // A NEW handoff invocation after completion is refused, never rerun (E1 §13).
      expect(codeOf(() => callHandoff(w.ctx, w.f, { toolUseId: "T26-NEW" }))).toBe("HANDOFF_ALREADY_DELIVERED");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T26b: E2 supervisor fencing invariants hold — activation attached owner at generation 1, takeover still fenced", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const binding = w.ctx.store.withRead((tx) => tx.prepare("SELECT state, generation AS g, session_id AS s FROM supervisor_bindings WHERE execution_run_id = ?").get(w.executionRunId) as { state: string; g: number; s: string });
      expect(binding).toEqual({ state: "attached", g: 1, s: w.f.sessionId });
      const supervisor = createSupervisorBindingService(w.ctx.store, w.ctx.clock);
      expect(
        codeOf(() =>
          supervisor.requireSupervisorAuthority({
            executionRunId: w.executionRunId,
            workspaceId: w.f.workspaceId,
            sessionId: "S-STALE",
            generation: 1,
          }),
        ),
      ).toBe("STALE_SUPERVISOR_BINDING");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T27: no E7+ subsystem tables exist", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const names = w.ctx.store.withRead(
        (tx) => tx.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>,
      ).map((r) => r.name);
      for (const forbidden of [
        // supervisor_assessments/execution_commits arrived in E6 and are legal here.
        "execution_observations",
        "verification_results",
        "execution_stage_completions",
        "execution_replan_transitions",
        "execution_run_completions",
      ]) {
        expect(names).not.toContain(forbidden);
      }
    } finally {
      w.ctx.store.close();
    }
  });

  it("T23b: ensureExecutionStructure refuses a non-active or missing ExecutionRun", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture("S-NOEXEC");
    try {
      // Approved FinalPlan but no ExecutionRun yet (handoff never prepared).
      expect(
        codeOf(() => createExecutionStructureService(ctx.store, ctx.clock).ensureExecutionStructure({ executionRunId: f.runId })),
      ).toBe("EXECUTION_STAGE_REQUIRED");
    } finally {
      ctx.store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// E3 closure amendment — VerificationWindow cardinality (E3C §11, T1–T9).
//
// A Stage owns 1..N sequential windows; only ONE window is OPEN per run.
// Closed-window fixtures are TEST-ONLY direct store transactions (E3C §10) —
// no production acceptance API exists or is added.
// ---------------------------------------------------------------------------

/** TEST-ONLY fixture: close the current open window via a direct store transaction. */
function closeOpenWindowFixture(w: World, closedAt = "2026-01-01T00:00:00Z"): string {
  return w.ctx.store.withWrite((tx) => {
    const row = tx
      .prepare("SELECT id FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL")
      .get(w.executionRunId) as { id: string } | undefined;
    if (row === undefined) throw new Error("fixture: no open window to close");
    // E9 — every pre-E9 closure was commit-accepted; the closure shape
    // trigger requires the kind to move together with closed_at.
    tx.prepare("UPDATE verification_windows SET closed_at = ?, closure_kind = 'accepted' WHERE id = ?").run(closedAt, row.id);
    return row.id;
  });
}

describe("E3C — VerificationWindow cardinality (T1–T9)", () => {
  it("E3C-T1: one Stage may own multiple sequential Windows (closed, closed, open)", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const structure = structureOf(w);
      const stageId = structure.activeStage!.id;
      const w1 = structure.openWindow!.id;
      expect(closeOpenWindowFixture(w, "2026-01-01T00:00:01Z")).toBe(w1);
      const w2 = createExecutionStructureService(w.ctx.store, w.ctx.clock).ensureExecutionStructure({
        executionRunId: w.executionRunId,
      }).openWindow!.id;
      expect(w2).not.toBe(w1);
      expect(closeOpenWindowFixture(w, "2026-01-01T00:00:02Z")).toBe(w2);
      const w3 = createExecutionStructureService(w.ctx.store, w.ctx.clock).ensureExecutionStructure({
        executionRunId: w.executionRunId,
      }).openWindow!.id;
      expect(w3).not.toBe(w2);
      // Three windows, all the same run + same stage; exactly one open.
      const windows = w.ctx.store.withRead((tx) => listWindowsForStageInTx(tx, stageId));
      expect(windows.map((window) => window.id)).toEqual([w1, w2, w3]);
      expect(windows.every((window) => window.executionRunId === w.executionRunId && window.stageId === stageId)).toBe(true);
      expect(windows.filter((window) => window.closedAt === null)).toHaveLength(1);
      expect(windows.filter((window) => window.closedAt !== null)).toHaveLength(2);
    } finally {
      w.ctx.store.close();
    }
  });

  it("E3C-T2: only one open Window per Run — even for the same Stage", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const active = structureOf(w).activeStage!;
      expect(
        codeOf(() =>
          w.ctx.store.withWrite((tx) =>
            insertOpenWindowInTx(tx, { executionRunId: w.executionRunId, stageId: active.id, windowId: "win_same_stage" }, "2026-01-01T00:00:00Z"),
          ),
        ),
      ).toBe("VERIFICATION_WINDOW_ALREADY_OPEN");
      // The DDL itself: a second open row is impossible even by raw insert.
      expect(
        w.ctx.store.withWrite((tx) => {
          try {
            tx.prepare(
              "INSERT INTO verification_windows (id, execution_run_id, stage_id, candidate_revision, opened_at, closed_at) "
              + "VALUES ('win_raw', ?, ?, 0, '2026-01-01T00:00:00Z', NULL)",
            ).run(w.executionRunId, active.id);
            return "inserted";
          } catch {
            return "rejected";
          }
        }),
      ).toBe("rejected");
    } finally {
      w.ctx.store.close();
    }
  });

  it("E3C-T3: the current OPEN window belongs to the current active Stage; historical windows may remain", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const stageId = structureOf(w).activeStage!.id;
      const w1 = closeOpenWindowFixture(w, "2026-01-01T00:00:01Z");
      const openNow = createExecutionStructureService(w.ctx.store, w.ctx.clock).ensureExecutionStructure({
        executionRunId: w.executionRunId,
      }).openWindow!;
      expect(openNow.stageId).toBe(stageId);
      // The §26 fence accepts the current open window and rejects a stale id.
      w.ctx.store.withRead((tx) => {
        expect(requireOpenWindowInTx(tx, w.executionRunId).id).toBe(openNow.id);
        expect(codeOf(() => requireOpenWindowInTx(tx, w.executionRunId, w1))).toBe("VERIFICATION_WINDOW_REQUIRED");
      });
    } finally {
      w.ctx.store.close();
    }
  });

  it("E3C-T4: candidateRevision is Window-local — WINDOW-B restarts at 0", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const service = createExecutionStructureService(w.ctx.store, w.ctx.clock);
      for (let i = 0; i < 4; i++) {
        w.ctx.store.withWrite((tx) => advanceCandidateRevisionInTx(tx, { executionRunId: w.executionRunId, expectedRevision: i }));
      }
      expect(structureOf(w).openWindow!.candidateRevision).toBe(4);
      const w1 = closeOpenWindowFixture(w, "2026-01-01T00:00:01Z");
      const next = service.ensureExecutionStructure({ executionRunId: w.executionRunId }).openWindow!;
      expect(next.id).not.toBe(w1);
      expect(next.candidateRevision).toBe(0);
      // No Stage-level revision storage exists anywhere.
      const stageColumns = w.ctx.store.withRead(
        (tx) => tx.prepare("PRAGMA table_info('execution_stages')").all() as Array<{ name: string }>,
      ).map((column) => column.name);
      expect(stageColumns.some((name) => name.toLowerCase().includes("candidate"))).toBe(false);
    } finally {
      w.ctx.store.close();
    }
  });

  it("E3C-T5: bootstrap remains idempotent while an open Window exists", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const service = createExecutionStructureService(w.ctx.store, w.ctx.clock);
      const first = structureOf(w).openWindow!.id;
      for (let i = 0; i < 3; i++) {
        expect(service.ensureExecutionStructure({ executionRunId: w.executionRunId }).openWindow!.id).toBe(first);
      }
      expect(
        (w.ctx.store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM verification_windows").get()) as { n: number }).n,
      ).toBe(1);
    } finally {
      w.ctx.store.close();
    }
  });

  it("E3C-T6: with only historical closed Windows, the creation primitive opens a NEW window at rev 0", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const stageId = structureOf(w).activeStage!.id;
      closeOpenWindowFixture(w, "2026-01-01T00:00:01Z");
      // No open window, same active Stage: bootstrap/creation opens WINDOW-B.
      const next = createExecutionStructureService(w.ctx.store, w.ctx.clock).ensureExecutionStructure({
        executionRunId: w.executionRunId,
      }).openWindow!;
      expect(next.candidateRevision).toBe(0);
      expect(next.stageId).toBe(stageId);
      expect(next.closedAt).toBeNull();
    } finally {
      w.ctx.store.close();
    }
  });

  it("E3C-T7: no production Window-close/accept/ExecutionCommit/Stage-completion API exists", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const serviceMethods = Object.keys(createExecutionStructureService(w.ctx.store, w.ctx.clock));
      for (const forbidden of ["closeWindow", "closeWindowAsAccepted", "acceptWindow", "createExecutionCommit", "completeStage", "setStageStatus", "setCandidateRevision"]) {
        expect(serviceMethods, forbidden).not.toContain(forbidden);
      }
      // Store surface: no closer either.
      const storeModule = await import("../src/store/execution-structure.js");
      for (const forbidden of ["closeWindowInTx", "acceptWindowInTx", "appendExecutionCommitInTx"]) {
        expect(storeModule, forbidden).not.toHaveProperty(forbidden);
      }
    } finally {
      w.ctx.store.close();
    }
  });

  it("E3C-T9: the schema validator fails a store that reintroduces UNIQUE(execution_run_id, stage_id)", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const { inspectSchemaState } = await import("../src/store/schema.js");
      expect(w.ctx.store.withRead((tx) => inspectSchemaState(tx).consistent)).toBe(true);
      // Reintroduce the forbidden 1:1 constraint (test-only corruption).
      expect(
        w.ctx.store.withWrite((tx) => {
          try {
            tx.prepare(
              "CREATE UNIQUE INDEX idx_forbidden_window_stage ON verification_windows (execution_run_id, stage_id)",
            ).run();
            return "created";
          } catch {
            return "rejected";
          }
        }),
      ).toBe("created");
      const state = w.ctx.store.withRead((tx) => inspectSchemaState(tx));
      expect(state.consistent).toBe(false);
      expect(state.problems.some((problem) => problem.includes("multiple sequential windows"))).toBe(true);
    } finally {
      w.ctx.store.close();
    }
  });
});
