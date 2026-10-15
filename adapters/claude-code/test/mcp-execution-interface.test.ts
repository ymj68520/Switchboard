/** Public-schema execution regressions: no policy injection or caller-computed obligation hashes. */
import { afterEach, describe, expect, it } from "vitest";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js";

import { executePhasePlanTool, PHASE_PLAN_TOOLS } from "../src/mcp/tools.js";
import type { CoveredObligation } from "../src/core/supervisor-assessment.js";
import { getExecutionDirectiveInTx } from "../src/store/execution-directives.js";
import { getExecutionRunInTx } from "../src/store/execution-runs.js";
import { getAcceptedHeadCommitIdInTx, getCompletionCommitIdInTx } from "../src/store/execution-commits.js";
import { makeAcceptanceWorld } from "./acceptance-helpers.js";
import { completeAllStagesFixture } from "./final-closure-helpers.js";
import { executionToken } from "./phase14-helpers.js";
import { freshWorkerSession, workerToken, type WorkerSession } from "./execution-worker-helpers.js";
import { codeOf, fullEnvelope, makeActiveExecutionWorld, openContract, type E4World } from "./execution-protocol-helpers.js";

const validator = new AjvJsonSchemaValidator();
let world: E4World | null = null;
let workerSequence = 0;

async function freshWorld(): Promise<E4World> {
  world = await makeActiveExecutionWorld(`INTERFACE-${Math.random().toString(36).slice(2, 8)}`);
  workerSequence = 0;
  return world;
}

afterEach(() => {
  world?.ctx.store.close();
  world = null;
});

function validateInput(tool: string, args: Record<string, unknown>) {
  const definition = PHASE_PLAN_TOOLS.find((entry) => entry.name === tool)!;
  return validator.getValidator<Record<string, unknown>>(definition.inputSchema as JsonSchemaType)(args);
}

/** Validate the advertised boundary before exercising the real signed MCP dispatcher. */
function call(w: E4World, tool: string, business: Record<string, unknown> = {}, worker?: WorkerSession) {
  const args = {
    ...business,
    _hostContext: worker === undefined
      ? executionToken(w.ctx, {
          sessionId: w.f.sessionId,
          workspaceId: w.f.workspaceId,
          runId: w.executionRunId,
          finalPlanId: w.f.finalPlanId,
          generation: w.f.generation,
          tool,
          business,
        })
      : workerToken(w.ctx, worker, tool, business),
  };
  const validated = validateInput(tool, args);
  expect(validated.errorMessage, `${tool} must accept its public input`).toBeUndefined();
  return executePhasePlanTool(w.ctx, tool, args);
}

function stageDirective(w: E4World, kind: string, fields: Record<string, unknown> = {}) {
  return {
    kind,
    stage_id: w.activeStageId,
    window_id: w.openWindowId,
    objective: "Complete the approved stage objective",
    body: "Work only within the approved stage and report actual results.",
    capability_envelope: fullEnvelope({ repositoryWrite: kind === "implementation" }),
    report_contract: openContract(),
    ...fields,
  };
}

type IssuedDirective = { directive: { id: string; revision: number; hash: string } };

function finishWorker(w: E4World, issued: IssuedDirective, role: "executor" | "verifier", mutated = false): string {
  const launch = call(w, "start_worker_attempt", {
    directive_id: issued.directive.id,
    directive_revision: issued.directive.revision,
    directive_hash: issued.directive.hash,
    worker_role: role,
  });
  const worker = freshWorkerSession(w, `INTERFACE-${++workerSequence}`);
  call(w, "worker_claim", { attempt_id: launch.attempt_id, launch_token: launch.launch_token }, worker);
  call(w, "worker_get_assignment", {}, worker);
  const report = call(w, "worker_submit_report", {
    result: "completed",
    candidate_mutated: mutated,
    actions_performed: [],
    files_examined: [],
    files_changed: mutated ? ["src/feature.ts"] : [],
    commands_run: [],
    tests_run: [],
    findings: [],
    deviations: [],
    blockers: [],
    deliverables: [],
  }, worker);
  return report.report_id as string;
}

interface AcceptanceProjection {
  active_stage: { id: string };
  open_window: { id: string; candidateRevision: number };
  stage_completion: {
    stageId: string;
    objectiveHash: string;
    obligation?: CoveredObligation;
    requiredVerificationRequirement: { requirement: string; detail: string };
  };
}

function stageReadyForAcceptance(w: E4World) {
  const context = call(w, "get_execution_acceptance_context") as unknown as AcceptanceProjection;
  expect(context.stage_completion.obligation).toBeDefined();
  w.activeStageId = context.active_stage.id;
  w.openWindowId = context.open_window.id;
  const implementation = call(w, "issue_execution_directive", stageDirective(w, "implementation", {
    verification_policy: { implementation_requirement: "immediate" },
  })) as unknown as IssuedDirective;
  finishWorker(w, implementation, "executor", true);
  const verification = call(w, "issue_execution_directive", stageDirective(w, "verification", {
    verification_policy: { verification_purpose: "normal" },
    validation_requirements: [context.stage_completion.requiredVerificationRequirement],
  })) as unknown as IssuedDirective;
  const reportId = finishWorker(w, verification, "verifier");
  const ready = call(w, "get_execution_acceptance_context") as unknown as AcceptanceProjection;
  return {
    disposition: "accept",
    rationale: "Fresh independent verification covers the exact stage objective.",
    expected_candidate_revision: ready.open_window.candidateRevision,
    report_judgments: [{ report_id: reportId, disposition: "supporting" }],
    covered_obligations: [ready.stage_completion.obligation!],
  };
}

function snakeObligation(obligation: CoveredObligation): Record<string, unknown> {
  return {
    source: obligation.source,
    stage_id: obligation.stageId,
    objective_hash: obligation.objectiveHash,
    contentHash: obligation.contentHash,
  };
}

describe("public execution directive schema", () => {
  it.each([
    ["implementation", { implementation_requirement: "batchable" }, { implementationRequirement: "batchable" }],
    ["implementation", { implementation_requirement: "immediate" }, { implementationRequirement: "immediate" }],
    ["verification", { verification_purpose: "normal" }, { verificationPurpose: "normal" }],
  ])("issues %s with the explicit policy %j", async (kind, policy, expected) => {
    const w = await freshWorld();
    const issued = call(w, "issue_execution_directive", stageDirective(w, kind as string, {
      verification_policy: policy,
    })) as unknown as IssuedDirective;
    const persisted = w.ctx.store.withRead((tx) =>
      getExecutionDirectiveInTx(tx, issued.directive.id, issued.directive.revision),
    );
    expect(persisted?.verificationPolicy).toEqual(expected);
  });

  it("advertises conflict-resolution policy while retaining the exact-conflict gate", async () => {
    const w = await freshWorld();
    expect(codeOf(() => call(w, "issue_execution_directive", stageDirective(w, "verification", {
      verification_policy: { verification_purpose: "conflict_resolution", verification_conflict_id: "missing-conflict" },
    })))).toBe("VERIFICATION_CONFLICT_INVALID");
  });

  it.each(["implementation", "verification"])("still refuses missing policy for %s", async (kind) => {
    const w = await freshWorld();
    expect(codeOf(() => call(w, "issue_execution_directive", stageDirective(w, kind)))).toBe("VERIFICATION_POLICY_INVALID");
  });

  it("allows inspection without inventing a verification policy", async () => {
    const w = await freshWorld();
    expect(call(w, "issue_execution_directive", stageDirective(w, "inspection")).status).toBe("issued");
  });

  it("retains the core kind-legality matrix for mixed policy fields", async () => {
    const w = await freshWorld();
    expect(codeOf(() => call(w, "issue_execution_directive", stageDirective(w, "implementation", {
      verification_policy: { implementation_requirement: "immediate", verification_purpose: "normal" },
    })))).toBe("VERIFICATION_POLICY_INVALID");
  });

  it.each([
    { implementation_requirement: "optional" },
    { verification_purpose: "skip" },
    { implementation_requirement: "immediate", bypass: true },
  ])("rejects malformed policy through the advertised schema: %j", async (policy) => {
    const w = await freshWorld();
    const result = validateInput("issue_execution_directive", {
      ...stageDirective(w, "implementation", { verification_policy: policy }),
      _hostContext: "schema-validation-only",
    });
    expect(result.valid).toBe(false);
  });
});

describe("public stage acceptance obligation", () => {
  it.each(["canonical", "snake_case"])("accepts the returned stage obligation using %s fields", async (style) => {
    const w = await freshWorld();
    const input = stageReadyForAcceptance(w);
    const obligation = input.covered_obligations[0]!;
    expect(obligation.source).toBe("stage_objective");
    expect(obligation.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(obligation.contentHash).not.toBe(obligation.objectiveHash);
    const result = call(w, "submit_supervisor_assessment", {
      ...input,
      covered_obligations: [style === "canonical" ? obligation : snakeObligation(obligation)],
    });
    expect(result.stage_completed).toBe(true);
    expect(result.status).toBe("accepted");
  });

  it("still refuses a fabricated content hash without committing acceptance", async () => {
    const w = await freshWorld();
    const input = stageReadyForAcceptance(w);
    expect(codeOf(() => call(w, "submit_supervisor_assessment", {
      ...input,
      covered_obligations: [{ ...input.covered_obligations[0], contentHash: `sha256:${"0".repeat(64)}` }],
    }))).toBe("STAGE_COMPLETION_OBLIGATION_INVALID");
    expect(w.ctx.store.withRead((tx) => getAcceptedHeadCommitIdInTx(tx, w.executionRunId))).toBeNull();
  });
});

describe("public final acceptance obligation", () => {
  it("returns the complete canonical obligation before and after opening final closure", async () => {
    const w = await makeAcceptanceWorld("INTERFACE-FINAL-PROJECTION");
    world = w;
    completeAllStagesFixture(w);
    const context = call(w, "get_execution_final_closure_context");
    expect(context.completion_obligation).toMatchObject({
      source: "execution_run_completion",
      executionRunId: w.executionRunId,
    });
    const opened = call(w, "begin_execution_final_closure");
    expect(opened.completion_obligation).toEqual(context.completion_obligation);
  });

  it.each(["canonical", "snake_case"])("advertises the complete run-completion identity using %s fields", (style) => {
    const identity = style === "canonical"
      ? { executionRunId: "exec-1", finalPlanHash: "sha256:plan", baseAcceptedHeadCommitId: "ec-2", completedStageSetHash: `sha256:${"1".repeat(64)}` }
      : { execution_run_id: "exec-1", final_plan_hash: "sha256:plan", base_accepted_head_commit_id: "ec-2", completed_stage_set_hash: `sha256:${"1".repeat(64)}` };
    const result = validateInput("submit_supervisor_assessment", {
      disposition: "accept",
      rationale: "Fresh final verification covers completion.",
      expected_candidate_revision: 0,
      covered_obligations: [{ source: "execution_run_completion", ...identity, contentHash: `sha256:${"2".repeat(64)}` }],
      _hostContext: "schema-validation-only",
    });
    expect(result.errorMessage).toBeUndefined();
  });

  it("completes both stages and final closure using only schema-valid MCP calls and returned obligations", async () => {
    const w = await freshWorld();
    for (let stage = 0; stage < 2; stage++) {
      const accepted = call(w, "submit_supervisor_assessment", stageReadyForAcceptance(w));
      expect(accepted.stage_completed).toBe(true);
      const progression = call(w, "get_execution_progression_context");
      if (stage === 0) {
        expect(progression.progression_boundary).toBe("between_stages");
        expect(progression.default_suggested_stage).toBeTypeOf("string");
        call(w, "activate_execution_stage", { target_stage_id: progression.default_suggested_stage });
      } else {
        expect(progression.progression_boundary).toBe("all_stages_completed");
      }
    }
    call(w, "begin_execution_final_closure");
    const final = call(w, "get_execution_final_closure_context") as {
      final_closure_window: { windowId: string; candidateRevision: number };
      completion_obligation: CoveredObligation;
      completion_verification_requirement: { requirement: string; detail: string };
    };
    const issued = call(w, "issue_execution_directive", {
      kind: "verification",
      scope_kind: "final_closure",
      window_id: final.final_closure_window.windowId,
      objective: "Verify integrated delivery and final execution completion",
      body: "Independently verify the approved FinalPlan without mutation.",
      capability_envelope: fullEnvelope(),
      report_contract: openContract(),
      verification_policy: { verification_purpose: "normal" },
      validation_requirements: [final.completion_verification_requirement],
    }) as unknown as IssuedDirective;
    const reportId = finishWorker(w, issued, "verifier");
    const result = call(w, "submit_supervisor_assessment", {
      disposition: "accept",
      rationale: "Fresh final verifier covers the exact run-completion obligation.",
      expected_candidate_revision: final.final_closure_window.candidateRevision,
      report_judgments: [{ report_id: reportId, disposition: "supporting" }],
      covered_obligations: [final.completion_obligation],
    });
    expect(result.run_completed).toBe(true);
    const persisted = w.ctx.store.withRead((tx) => getExecutionRunInTx(tx, w.executionRunId));
    expect(persisted?.lifecycle).toBe("completed");
    expect(w.ctx.store.withRead((tx) => getCompletionCommitIdInTx(tx, w.executionRunId))).toBeTruthy();
  });
});
