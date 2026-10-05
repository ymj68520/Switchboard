/**
 * E6 §68 — recovery projection tests (E6-T43..T45) and §69 E6-T51 (no E7
 * artifacts): the capsule shows the exact acceptedHead, the post-commit
 * boundary without mutating state, historical assessments/commits stay
 * queryable in the Store, and NO production module/table implements Stage
 * completion, next-Stage activation, verification scheduling,
 * conflict-resolution orchestration, REPLAN_REQUIRED, run completion, final
 * verification closure, or ExecutionObservation.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  acceptInput,
  acceptanceServiceOf,
  codeOf,
  completeActiveStageFixture,
  makeAcceptanceWorld,
  runDirectiveCycle,
  runVerificationCycle,
  supervisorCall,
  type AcceptanceWorld,
} from "./acceptance-helpers.js";
import { createSupervisorBindingService } from "../src/application/supervisor-binding-service.js";
import { renderExecutionRecoveryContext } from "../src/context/execution-recovery.js";

let world: AcceptanceWorld | null = null;

async function freshWorld(): Promise<AcceptanceWorld> {
  world = await makeAcceptanceWorld(`RC-${Math.random().toString(36).slice(2, 8)}`);
  return world;
}

function capsuleOf(w: AcceptanceWorld): string {
  const supervisorService = createSupervisorBindingService(w.ctx.store, w.ctx.clock);
  const facts = w.ctx.store.withRead((tx) =>
    supervisorService.loadExecutionRecoveryFactsInTx(tx, { executionRunId: w.executionRunId, sessionId: w.f.sessionId }),
  );
  return renderExecutionRecoveryContext(facts);
}

afterEach(() => {
  world?.ctx.store.close();
  world = null;
});

describe("E6 recovery context", () => {
  it("E6-T43: the capsule shows the exact current accepted head", async () => {
    const w = await freshWorld();
    // Before any commit: the execution-start baseline is the accepted base.
    expect(capsuleOf(w)).toContain("accepted head: execution_start (no accepted commits yet)");
    runVerificationCycle(w);
    const { commit } = acceptanceServiceOf(w).submitSupervisorAssessment(acceptInput(w) as never)!;
    const capsule = capsuleOf(w);
    expect(capsule).toContain(`accepted head: ${commit!.commitId} (sequence 1)`);
    expect(capsule).toContain(`latest commit: ${commit!.commitId} (sequence 1, parent execution_start`);
    expect(capsule).toContain(`latest assessment: ${commit!.supervisorAssessmentId}`);
    expect(capsule).toContain("A report never creates accepted progress; only a Core-gated ExecutionCommit does");
  });

  it("E6-T44: the post-commit boundary is shown without changing any state", async () => {
    const w = await freshWorld();
    runVerificationCycle(w);
    const { commit } = acceptanceServiceOf(w).submitSupervisorAssessment(acceptInput(w) as never)!;
    const before = w.ctx.store.withRead(
      (tx) =>
        ({
          head: tx.prepare("SELECT accepted_head_commit_id AS head FROM execution_runs WHERE execution_run_id = ?").get(w.executionRunId),
          open: tx.prepare("SELECT count(*) AS n FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL").get(w.executionRunId),
          runRevision: tx.prepare("SELECT revision FROM execution_runs WHERE execution_run_id = ?").get(w.executionRunId),
        }) as { head: { head: string }; open: { n: number }; runRevision: { revision: number } },
    );
    const capsule = capsuleOf(w);
    expect(capsule).toContain("open window: none (post-commit acceptance boundary");
    expect(capsule).toContain("disposition=accept");
    // The projection never writes back: identical store state after render.
    const after = w.ctx.store.withRead(
      (tx) =>
        ({
          head: tx.prepare("SELECT accepted_head_commit_id AS head FROM execution_runs WHERE execution_run_id = ?").get(w.executionRunId),
          open: tx.prepare("SELECT count(*) AS n FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL").get(w.executionRunId),
          runRevision: tx.prepare("SELECT revision FROM execution_runs WHERE execution_run_id = ?").get(w.executionRunId),
        }) as { head: { head: string }; open: { n: number }; runRevision: { revision: number } },
    );
    expect(after).toEqual(before);
    expect(after.head.head).toBe(commit!.commitId);
  });

  it("E6-T45: historical assessments stay queryable, current vs stale", async () => {
    const w = await freshWorld();
    const service = acceptanceServiceOf(w);
    // A durable non-accept judgment at revision 1, then the candidate moves.
    service.submitSupervisorAssessment(
      acceptInput(w, { disposition: "request_replan", reportJudgments: [], rationale: "not sufficient yet." }) as never,
    );
    runDirectiveCycle(w, { directiveId: "DIR-I3", kind: "implementation", reportOverrides: { candidate_mutated: true } });
    runVerificationCycle(w);
    const result = service.submitSupervisorAssessment(acceptInput(w) as never);
    expect(result.commit).not.toBeNull();
    const assessments = w.ctx.store.withRead(
      (tx) =>
        tx.prepare("SELECT assessment_id AS id, candidate_revision AS revision, disposition FROM supervisor_assessments WHERE execution_run_id = ? ORDER BY created_at").all(w.executionRunId) as Array<{
          id: string;
          revision: number;
          disposition: string;
        }>,
    );
    expect(assessments.map((row) => row.disposition)).toEqual(["request_replan", "accept"]);
    expect(assessments[0]?.revision).toBe(1);
    expect(assessments[1]?.revision).toBe(2);
    // The event ledger keeps the full acceptance history too.
    const events = w.ctx.store.withRead(
      (tx) =>
        tx.prepare("SELECT event_type AS type FROM execution_acceptance_events WHERE execution_run_id = ? ORDER BY event_seq").all(w.executionRunId) as Array<{
          type: string;
        }>,
    );
    expect(events.map((row) => row.type)).toEqual(["ASSESSMENT_RECORDED", "ASSESSMENT_RECORDED", "EXECUTION_COMMIT_CREATED"]);
  });
});

describe("E6-T51: no E7 artifacts exist in the production tree", () => {
  it("no module, table, or service surface implements the deferred subsystems", async () => {
    const w = await freshWorld();
    try {
      // 1. No production module whose NAME implements the deferred subsystems
      //    (assessment/commit/accepted-head are E6-legal; the E7+ set is not).
      const srcRoot = path.resolve(__dirname, "../src");
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.isFile() && entry.name.endsWith(".ts")) {
            // E7 legitimizes the stage-completion/progression modules; E10
            // legitimizes the final-closure/run-completion modules (§38/§44).
            // The still-deferred subsystems stay unimplemented.
            expect(path.basename(entry.name), full).not.toMatch(
              /verification-sched|replan-transition|execution-observation|abort-authorization/i,
            );
          }
        }
      };
      walk(srcRoot);
      // 2. No deferred-subsystem tables.
      const tables = w.ctx.store.withRead(
        (tx) => tx.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>,
      ).map((row) => row.name);
      for (const forbidden of [
        "execution_observations",
        "verification_results",
        "execution_stage_completions",
        "execution_replan_transitions",
        "execution_run_completions",
      ]) {
        expect(tables).not.toContain(forbidden);
      }
      // 3. No application service exposes Stage completion / next-Stage
      //    activation / scheduling / replan / run-completion primitives.
      const { createAcceptanceService } = await import("../src/application/acceptance-service.js");
      const services = [
        createAcceptanceService(w.ctx.store, w.ctx.clock),
        (await import("../src/application/execution-structure-service.js")).createExecutionStructureService(w.ctx.store, w.ctx.clock),
      ] as Array<Record<string, unknown>>;
      for (const forbidden of [
        "completeStage",
        "completeActiveStage",
        "activateNextStage",
        "scheduleVerification",
        "resolveConflict",
        "transitionToReplan",
        "completeRun",
        "closeExecution",
        "recordExecutionObservation",
      ]) {
        for (const service of services) {
          expect(Object.keys(service)).not.toContain(forbidden);
        }
      }
      // 4. The supervisor service still projects — and the acceptance service
      //    exposes exactly the E6 surface (context / assessment / successor).
      expect(Object.keys(createSupervisorBindingService(w.ctx.store, w.ctx.clock))).toContain(
        "loadExecutionRecoveryFactsInTx",
      );
    } finally {
      w.ctx.store.close();
    }
  });
});

describe("E7 progression recovery (§26/§27) — passive, never acting", () => {
  it("E7-T22: the post-intermediate-commit boundary survives recovery unchanged; no window is auto-opened", async () => {
    const w = await freshWorld();
    runVerificationCycle(w);
    acceptanceServiceOf(w).submitSupervisorAssessment(acceptInput(w, { coveredObligations: [] }) as never);
    const before = w.ctx.store.withRead((tx) => ({
      head: tx.prepare("SELECT accepted_head_commit_id AS head FROM execution_runs WHERE execution_run_id = ?").get(w.executionRunId),
      open: tx.prepare("SELECT count(*) AS n FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL").get(w.executionRunId),
      stages: tx.prepare("SELECT id, status, revision FROM execution_stages WHERE execution_run_id = ? ORDER BY ordinal").all(w.executionRunId),
    }));
    const capsule = capsuleOf(w);
    expect(capsule).toContain("progression boundary: post-commit same-stage");
    expect(capsule).toContain("open window: none (post-commit acceptance boundary");
    // Re-rendering (SessionStart / compaction) changes nothing, and the
    // recovery bootstrap never silently continues the Stage.
    expect(capsuleOf(w)).toBe(capsule);
    const { ensureExecutionStructureInTx } = await import("../src/application/execution-structure-service.js");
    w.ctx.store.withWrite((tx) => ensureExecutionStructureInTx(tx, w.executionRunId, w.ctx.clock, w.ctx.clock.nowIso()));
    const after = w.ctx.store.withRead((tx) => ({
      head: tx.prepare("SELECT accepted_head_commit_id AS head FROM execution_runs WHERE execution_run_id = ?").get(w.executionRunId),
      open: tx.prepare("SELECT count(*) AS n FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL").get(w.executionRunId),
      stages: tx.prepare("SELECT id, status, revision FROM execution_stages WHERE execution_run_id = ? ORDER BY ordinal").all(w.executionRunId),
    }));
    expect(after).toEqual(before);
  });

  it("E7-T23: the between-stages boundary names the eligible Stages and never auto-activates", async () => {
    const w = await freshWorld();
    completeActiveStageFixture(w);
    const pendingId = w.ctx.store.withRead(
      (tx) =>
        (tx.prepare("SELECT id FROM execution_stages WHERE execution_run_id = ? AND status = 'pending'").get(w.executionRunId) as { id: string }).id,
    );
    const capsule = capsuleOf(w);
    expect(capsule).toContain("progression boundary: between stages");
    expect(capsule).toContain(`eligible next stages: [${pendingId}]`);
    expect(capsule).toContain("no auto-activation");
    expect(capsule).toContain("active stage: none");
    // Recovery bootstrap: no activation, no window, pending Stage untouched.
    const { ensureExecutionStructureInTx } = await import("../src/application/execution-structure-service.js");
    w.ctx.store.withWrite((tx) => ensureExecutionStructureInTx(tx, w.executionRunId, w.ctx.clock, w.ctx.clock.nowIso()));
    const after = w.ctx.store.withRead((tx) => ({
      active: tx.prepare("SELECT count(*) AS n FROM execution_stages WHERE execution_run_id = ? AND status = 'active'").get(w.executionRunId),
      pending: tx.prepare("SELECT status FROM execution_stages WHERE id = ?").get(pendingId),
      open: tx.prepare("SELECT count(*) AS n FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL").get(w.executionRunId),
    }));
    expect(after).toEqual({
      active: { n: 0 },
      pending: { status: "pending" },
      open: { n: 0 },
    });
  });

  it("E7-T24 + T27 + T28 + E10 §10: all stages completed — the explicit final-closure boundary, run stays active, no final window", async () => {
    const w = await freshWorld();
    completeActiveStageFixture(w);
    const pendingId = w.ctx.store.withRead(
      (tx) =>
        (tx.prepare("SELECT id FROM execution_stages WHERE execution_run_id = ? AND status = 'pending'").get(w.executionRunId) as { id: string }).id,
    );
    supervisorCall(w, "activate_execution_stage", { target_stage_id: pendingId });
    completeActiveStageFixture(w);
    const capsule = capsuleOf(w);
    expect(capsule).toContain("progression boundary: all stages completed — explicitly begin final execution closure (begin_execution_final_closure) when ready; the boundary never auto-starts it (E10 §10)");
    expect(capsule).toContain("Lifecycle: active");
    expect(capsule).toContain("active stage: none");
    expect(capsule).toContain("open window: none");
    // E7-T27 — every E7 path leaves the ExecutionRun active (no completion).
    const run = w.ctx.store.withRead(
      (tx) => tx.prepare("SELECT lifecycle FROM execution_runs WHERE execution_run_id = ?").get(w.executionRunId) as { lifecycle: string },
    );
    expect(run.lifecycle).toBe("active");
    // E7-T28 — no final verification window is created, and recovery never
    // opens one (the genesis bootstrap is head-gated, E6 §34).
    const { ensureExecutionStructureInTx } = await import("../src/application/execution-structure-service.js");
    w.ctx.store.withWrite((tx) => ensureExecutionStructureInTx(tx, w.executionRunId, w.ctx.clock, w.ctx.clock.nowIso()));
    const open = w.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL").get(w.executionRunId),
    );
    expect(open).toEqual({ n: 0 });
  });

  it("E7-T27b + E10 §44: no model-facing path completes the ExecutionRun", async () => {
    const srcRoot = path.resolve(__dirname, "../src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith(".ts")) {
          const text = fs.readFileSync(full, "utf8");
          if (/execution_runs SET lifecycle = 'completed'/i.test(text)) {
            offenders.push(path.relative(srcRoot, full));
          }
        }
      }
    };
    walk(srcRoot);
    // E10 §44 — the transition exists as ONE internal store primitive, called
    // only from the final acceptance / ExecutionCompletionGate. No model-facing
    // complete_execution_run / set_lifecycle_completed / force_complete tool
    // exists anywhere.
    expect(offenders).toHaveLength(1);
    expect(offenders[0]!.split(path.sep).join("/")).toBe("store/execution-runs.ts");
    const toolsText = fs.readFileSync(path.resolve(__dirname, "../src/mcp/tools.ts"), "utf8");
    expect(toolsText).not.toMatch(/complete_execution_run|set_lifecycle_completed|force_complete/);
  });
});

describe("E8 verification policy + conflict recovery (§44) — passive projection", () => {
  it("the capsule shows the derived verification pressure and the one blocking conflict, and never acts on them", async () => {
    const w = await freshWorld();
    // Span 1 from the fixture mutation: policy visible, no conflict yet.
    let capsule = capsuleOf(w);
    expect(capsule).toContain("verification policy: not required");
    expect(capsule).toContain("span 1/3");
    expect(capsule).toContain("verification conflict: none");
    // An immediate mutating directive puts the run in verification debt.
    runDirectiveCycle(w, {
      directiveId: "DIR-IMM-RC",
      kind: "implementation",
      directiveOverrides: { verificationPolicy: { implementationRequirement: "immediate" } },
      reportOverrides: { candidate_mutated: true, files_changed: ["src/x.ts"] },
    });
    capsule = capsuleOf(w);
    expect(capsule).toContain("verification policy: required (reason=immediate)");
    // A declaration needs two DISTINCT trusted reports — Core refuses the
    // malformed one, and the capsule still shows the debt with no conflict.
    const refusal = codeOf(() =>
      supervisorCall(w, "declare_verification_conflict", {
        fact: "recovery fixture fact",
        claims: [
          { variant: "A", statement: "a", source_report_ids: [w.verReportId ?? "rep_none"] },
          { variant: "B", statement: "b", source_report_ids: [w.verReportId ?? "rep_none"] },
        ],
      }),
    );
    expect(refusal).toBe("VERIFICATION_CONFLICT_INVALID");
    expect(capsuleOf(w)).toContain("verification conflict: none");
    // Rendering is passive: identical on re-render.
    expect(capsuleOf(w)).toBe(capsuleOf(w));
  });

  it("E8 §44: the conflict line appears when a conflict blocks the candidate and clears by mutation", async () => {
    const w = await freshWorld();
    // Two trusted current reports: verifier + non-mutating inspection.
    runVerificationCycle(w);
    const inspection = runDirectiveCycle(w, { directiveId: "DIR-INS-RC", kind: "inspection" });
    const declared = supervisorCall(w, "declare_verification_conflict", {
      fact: "the capsule fixture fact",
      claims: [
        { variant: "A", statement: "a", source_report_ids: [w.verReportId!] },
        { variant: "B", statement: "b", source_report_ids: [inspection.reportId] },
      ],
    }) as { conflict: { id: string } };
    let capsule = capsuleOf(w);
    expect(capsule).toContain(`verification conflict: ${declared.conflict.id} (open) at candidateRevision=1`);
    // A mutating rework creates a new candidate; the old conflict becomes
    // historical and the capsule's conflict line clears.
    runDirectiveCycle(w, {
      directiveId: "DIR-REWORK-RC",
      kind: "implementation",
      reportOverrides: { candidate_mutated: true, files_changed: ["src/rc.ts"] },
    });
    capsule = capsuleOf(w);
    expect(capsule).toContain("verification conflict: none");
    // The conflict row itself is untouched (never rewritten, E8 §39).
    const stored = w.ctx.store.withRead(
      (tx) =>
        tx.prepare("SELECT status, candidate_revision AS revision FROM verification_conflicts WHERE conflict_id = ?").get(
          declared.conflict.id,
        ) as { status: string; revision: number },
    );
    expect(stored).toEqual({ status: "open", revision: 1 });
  });
});
