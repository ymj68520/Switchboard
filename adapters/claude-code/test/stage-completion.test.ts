/**
 * E7 §47 — Stage completion tests (E7-T4..T10).
 *
 * A Stage becomes completed ONLY when an ACCEPTED ExecutionCommit carries the
 * exact deterministic stage_objective obligation, AND the fresh supporting
 * verification explicitly covers Stage completion (the derived
 * verify_stage_completion requirement carried by the verifier's own Directive).
 * Non-accept assessments never complete a Stage (E7 §7); a claim with a wrong
 * Stage, a stale hash, or generic verification rejects the WHOLE accept
 * transaction (E7 §35/§36); there is no model-facing completion API (E7 §14).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  acceptInput,
  acceptanceServiceOf,
  codeOf,
  makeAcceptanceWorld,
  messageOf,
  runVerificationCycle,
  type AcceptanceWorld,
} from "./acceptance-helpers.js";
import { PHASE_PLAN_TOOLS } from "../src/mcp/tools.js";
import { deriveStageCompletionValidationRequirement, stageObjectiveHash, stageObjectiveObligation } from "../src/core/stage-completion.js";
import { completeStageByExecutionCommitInTx, getExecutionStageInTx } from "../src/store/execution-structure.js";

let world: AcceptanceWorld | null = null;

async function freshWorld(): Promise<AcceptanceWorld> {
  world = await makeAcceptanceWorld(`SC-${Math.random().toString(36).slice(2, 8)}`);
  return world;
}

function activeStageOf(w: AcceptanceWorld) {
  return w.ctx.store.withRead((tx) => getExecutionStageInTx(tx, w.activeStageId))!;
}

afterEach(() => {
  world?.ctx.store.close();
  world = null;
});

describe("E7 stage completion — deterministic obligation identity (§5/§9)", () => {
  it("E7-T4: stage_objective identity is deterministic, immutable, and free of execution state", async () => {
    const w = await freshWorld();
    const stage = activeStageOf(w);
    const first = stageObjectiveHash(stage);
    const second = stageObjectiveHash(stage);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second).toBe(first);
    // The derived verification requirement binds stageId + objectiveHash via
    // the deterministic encoded content (E7 §9).
    const requirement = deriveStageCompletionValidationRequirement(stage);
    expect(requirement.requirement).toBe("verify_stage_completion");
    expect(requirement.detail).toBe(first);
    // Mutable execution state never enters the identity: bump revision/status
    // directly and the hash is unchanged.
    const mutated = { ...stage, status: "completed" as const, revision: stage.revision + 5 };
    expect(stageObjectiveHash(mutated)).toBe(first);
    // The obligation roundtrips with the exact contentHash contract.
    const obligation = stageObjectiveObligation(stage);
    expect(obligation.source).toBe("stage_objective");
    expect(obligation.stageId).toBe(stage.id);
    expect(obligation.objectiveHash).toBe(first);
    expect(obligation.contentHash).toBe(stageObjectiveObligation(stage).contentHash);
  });
});

describe("E7 stage completion — gate refusals (§35/§36)", () => {
  it("E7-T5: a wrong Stage or stale objectiveHash is refused with the stable error", async () => {
    const w = await freshWorld();
    const stage = activeStageOf(w);
    const pending = w.ctx.store.withRead((tx) =>
      tx.prepare("SELECT id FROM execution_stages WHERE execution_run_id = ? AND status = 'pending'").get(w.executionRunId) as { id: string },
    );
    runVerificationCycle(w);
    const service = acceptanceServiceOf(w);
    // Another Stage's id — even a real pending Stage of the same run.
    expect(
      codeOf(() =>
        service.submitSupervisorAssessment(
          acceptInput(w, { coveredObligations: [{ ...stageObjectiveObligation(stage), stageId: pending.id }] }) as never,
        ),
      ),
    ).toBe("STAGE_COMPLETION_OBLIGATION_INVALID");
    // A stale/fabricated objectiveHash.
    expect(
      codeOf(() =>
        service.submitSupervisorAssessment(
          acceptInput(w, {
            coveredObligations: [{ ...stageObjectiveObligation(stage), objectiveHash: `sha256:${"0".repeat(64)}` }],
          }) as never,
        ),
      ),
    ).toBe("STAGE_COMPLETION_OBLIGATION_INVALID");
    // Nothing was persisted by either refusal.
    const assessments = w.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM supervisor_assessments").get() as { n: number },
    );
    expect(assessments.n).toBe(0);
  });

  it("E7-T6: a NON-accept assessment carrying the Stage obligation never completes the Stage", async () => {
    const w = await freshWorld();
    const stage = activeStageOf(w);
    runVerificationCycle(w);
    const service = acceptanceServiceOf(w);
    const result = service.submitSupervisorAssessment(
      acceptInput(w, {
        disposition: "rework",
        rationale: "Implementation is close but one deviation needs rework before acceptance.",
        coveredObligations: [stageObjectiveObligation(stage)],
      }) as never,
    );
    expect(result.commit).toBeNull();
    expect(result.stageCompleted).toBe(false);
    const after = w.ctx.store.withRead((tx) => getExecutionStageInTx(tx, stage.id))!;
    expect(after.status).toBe("active");
    expect(after.completedByCommitId).toBeNull();
    // The judgment (with its obligation provenance) is durable history.
    const stored = w.ctx.store.withRead(
      (tx) =>
        tx.prepare("SELECT covered_obligations_json AS obligations FROM supervisor_assessments WHERE assessment_id = ?").get(
          result.assessment.assessmentId,
        ) as { obligations: string },
    );
    expect(JSON.parse(stored.obligations)).toEqual([stageObjectiveObligation(stage)]);
  });

  it("E7-T7: accept + stage_objective without Stage-completion verification rejects the WHOLE transaction", async () => {
    const w = await freshWorld();
    const stage = activeStageOf(w);
    // A plain verifier: qualifying for an intermediate commit, but its
    // Directive does NOT carry the derived stage-completion requirement.
    runVerificationCycle(w);
    const service = acceptanceServiceOf(w);
    expect(
      codeOf(() =>
        service.submitSupervisorAssessment(acceptInput(w, { coveredObligations: [stageObjectiveObligation(stage)] }) as never),
      ),
    ).toBe("STAGE_COMPLETION_VERIFICATION_REQUIRED");
    // E7 §36 — no assessment, no commit, no window close, no head movement, no
    // Stage transition survived.
    const after = w.ctx.store.withRead((tx) => ({
      assessments: tx.prepare("SELECT count(*) AS n FROM supervisor_assessments").get() as { n: number },
      commits: tx.prepare("SELECT count(*) AS n FROM execution_commits").get() as { n: number },
      window: tx.prepare("SELECT closed_at FROM verification_windows WHERE id = ?").get(w.openWindowId) as { closed_at: string | null },
      stage: tx.prepare("SELECT status FROM execution_stages WHERE id = ?").get(stage.id) as { status: string },
      head: tx.prepare("SELECT accepted_head_commit_id AS head FROM execution_runs WHERE execution_run_id = ?").get(w.executionRunId) as { head: string | null },
    }));
    expect(after.assessments.n).toBe(0);
    expect(after.commits.n).toBe(0);
    expect(after.window.closed_at).toBeNull();
    expect(after.stage.status).toBe("active");
    expect(after.head.head).toBeNull();
  });
});

describe("E7 stage completion — the valid atomic completion (§11/§12)", () => {
  it("E7-T8: exact obligation + fresh covering verification completes the Stage atomically", async () => {
    const w = await freshWorld();
    const stage = activeStageOf(w);
    const requirement = deriveStageCompletionValidationRequirement(stage);
    const verification = runVerificationCycle(w, {
      directiveOverrides: { validationRequirements: [requirement] },
    });
    const service = acceptanceServiceOf(w);
    const result = service.submitSupervisorAssessment(
      acceptInput(w, {
        coveredObligations: [stageObjectiveObligation(stage)],
      }) as never,
    );
    expect(result.commit).not.toBeNull();
    expect(result.stageCompleted).toBe(true);
    const after = w.ctx.store.withRead((tx) => ({
      stage: getExecutionStageInTx(tx, stage.id)!,
      head: tx.prepare("SELECT accepted_head_commit_id AS head FROM execution_runs WHERE execution_run_id = ?").get(w.executionRunId) as { head: string | null },
      window: tx.prepare("SELECT closed_at FROM verification_windows WHERE id = ?").get(w.openWindowId) as { closed_at: string | null },
    }));
    expect(after.stage.status).toBe("completed");
    expect(after.stage.completedByCommitId).toBe(result.commit!.commitId);
    expect(after.head.head).toBe(result.commit!.commitId);
    expect(after.window.closed_at).not.toBeNull();
    // The commit carries the exact stage_objective provenance.
    expect(result.commit!.satisfiedObligations).toEqual([stageObjectiveObligation(stage)]);
    // E7 §33 — the acceptance context now reflects the completed Stage: no
    // active Stage remains, so there is no Stage-completion block.
    const context = service.getExecutionAcceptanceContext({ executionRunId: w.executionRunId });
    expect(context.stageCompletion).toBeNull();
    expect(context.activeStage).toBeNull();
    expect(verification.reportId).not.toBeNull();
  });

  it("E7-T9: a mid-transaction failure rolls back assessment, commit, window close, head, and completion", async () => {
    const w = await freshWorld();
    const stage = activeStageOf(w);
    const requirement = deriveStageCompletionValidationRequirement(stage);
    runVerificationCycle(w, { directiveOverrides: { validationRequirements: [requirement] } });
    // Force a mid-persist failure: a pre-existing commit for the OPEN window
    // (SQL-fabricated corruption, with its FK-satisfying fabricated assessment)
    // makes the commit INSERT fail inside the gate — after the assessment was
    // (tentatively) written.
    w.ctx.store.withWrite((tx) => {
      tx.prepare(
        "INSERT INTO supervisor_assessments (assessment_id, execution_run_id, stage_id, window_id, candidate_revision, "
        + "disposition, supervisor_session_id, supervisor_generation, plan_refs_json, covered_obligations_json, "
        + "rationale, created_at) VALUES ('sa_fabricated', ?, ?, ?, 1, 'rework', 'S-FAB', 1, '[]', '[]', 'fabricated', 'now')",
      ).run(w.executionRunId, stage.id, w.openWindowId);
      tx.prepare(
        "INSERT INTO execution_commits (commit_id, execution_run_id, sequence, parent_commit_id, stage_id, window_id, "
        + "candidate_revision, supervisor_assessment_id, directive_refs_json, report_refs_json, "
        + "satisfied_obligations_json, created_at) VALUES (?, ?, 1, NULL, ?, ?, 1, 'sa_fabricated', '[]', '[]', '[]', 'now')",
      ).run("ec_fabricated", w.executionRunId, stage.id, w.openWindowId);
    });
    const service = acceptanceServiceOf(w);
    expect(
      codeOf(() =>
        service.submitSupervisorAssessment(
          acceptInput(w, { coveredObligations: [stageObjectiveObligation(stage)] }) as never,
        ),
      ),
    ).toBe("EXECUTION_COMMIT_ALREADY_EXISTS");
    const after = w.ctx.store.withRead((tx) => ({
      assessments: tx.prepare("SELECT count(*) AS n FROM supervisor_assessments").get() as { n: number },
      judgments: tx.prepare("SELECT count(*) AS n FROM supervisor_assessment_report_judgments").get() as { n: number },
      commits: tx.prepare("SELECT count(*) AS n FROM execution_commits").get() as { n: number },
      window: tx.prepare("SELECT closed_at FROM verification_windows WHERE id = ?").get(w.openWindowId) as { closed_at: string | null },
      stage: getExecutionStageInTx(tx, stage.id)!,
      head: tx.prepare("SELECT accepted_head_commit_id AS head FROM execution_runs WHERE execution_run_id = ?").get(w.executionRunId) as { head: string | null },
    }));
    expect(after.assessments.n).toBe(1); // only the fabricated probe (pre-transaction)
    expect(after.judgments.n).toBe(0);
    expect(after.commits.n).toBe(1); // only the fabricated probe
    expect(after.window.closed_at).toBeNull();
    expect(after.stage.status).toBe("active");
    expect(after.stage.completedByCommitId).toBeNull();
    expect(after.head.head).toBeNull();
    // The completion primitive itself fails closed off the happy path: never
    // completes a non-active Stage (the run's pending second Stage), never
    // invents provenance — probed with a REAL commit id so the FK is satisfied
    // and the conditional UPDATE itself is what refuses.
    const pendingId = w.ctx.store.withRead(
      (tx) =>
        (tx.prepare("SELECT id FROM execution_stages WHERE execution_run_id = ? AND status = 'pending'").get(w.executionRunId) as { id: string }).id,
    );
    expect(
      messageOf(() =>
        w.ctx.store.withWrite((tx) =>
          completeStageByExecutionCommitInTx(tx, { stageId: pendingId, commitId: "ec_fabricated" }, w.ctx.clock.nowIso()),
        ),
      ),
    ).toContain("could not be completed");
  });

  it("E7-T10: static proof — no model-facing completion API; one production caller", async () => {
    // No tool manifests a completion/status-setter surface.
    const toolNames = PHASE_PLAN_TOOLS.map((tool) => tool.name);
    for (const name of toolNames) {
      expect(name).not.toMatch(/complete_stage|set_stage_status|force_complete|status_setter/);
    }
    // The completion primitive has EXACTLY ONE production caller: the
    // acceptance gate.
    const srcRoot = path.resolve(__dirname, "../src");
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith(".ts")) {
          if (fs.readFileSync(full, "utf8").includes("completeStageByExecutionCommitInTx(")) {
            callers.push(path.relative(srcRoot, full).split(path.sep).join("/"));
          }
        }
      }
    };
    walk(srcRoot);
    expect(callers.sort()).toEqual(["application/acceptance-service.ts", "store/execution-structure.ts"]);
  });
});
