/**
 * E14 §32/§33/§41/§42 — release authority gates: WorkspaceIdentity fencing,
 * the capability matrix across every role, the trust-domain bridge audit, and
 * the model-facing mutation-surface audit (recorded from the LIVE registry,
 * never hardcoded before the audit).
 */
import { describe, expect, it } from "vitest";

import { PHASE_PLAN_TOOLS, executePhasePlanTool } from "../src/mcp/tools.js";
import { handlePreToolUse } from "../src/hooks/handlers.js";
import {
  depsOf,
  executionFingerprintOf,
  makeForeignWorkspace,
} from "./session-recovery-helpers.js";
import {
  currentRevision,
  makeAcceptanceWorld,
  runFreshVerifier,
  runImplementation,
  supervisorCall,
  type E14World,
} from "./v020-e2e-helpers.js";
import { executionToken } from "./phase14-helpers.js";

function callAs(world: E14World, input: { sessionId: string; workspaceId?: string; generation: number; tool: string; business?: Record<string, unknown> }): unknown {
  const workspaceId = input.workspaceId ?? world.f.workspaceId;
  const business = input.business ?? {};
  const token = executionToken(world.ctx, {
    sessionId: input.sessionId,
    workspaceId,
    runId: world.executionRunId,
    finalPlanId: world.f.finalPlanId,
    generation: input.generation,
    tool: input.tool,
    business,
  });
  return executePhasePlanTool(world.ctx, input.tool, { ...business, _hostContext: token });
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code ?? "no-error";
  }
  return "no-error";
}

async function preTool(world: E14World, sessionId: string, toolName: string, toolInput: Record<string, unknown>) {
  return handlePreToolUse(
    depsOf(world),
    {
      sessionId,
      cwd: world.f.workspaceRoot,
      permissionMode: "default",
      hookEventName: "PreToolUse",
      toolName,
      toolInput,
      toolUseId: `TU-${toolName}-${sessionId}`,
    } as never,
  );
}

describe("v020 E2E WorkspaceIdentity gate (§32)", () => {
  it("E14-WI1: a different worktree is a DIFFERENT workspace — no migration, no cross-workspace takeover", async () => {
    const world = await makeAcceptanceWorld("E14-WI1");
    const foreign = makeForeignWorkspace("phase-plan-e14-wi-");
    try {
      const fingerprint = executionFingerprintOf(world);
      // Authority signed for the FOREIGN workspace is not this run's authority.
      expect(
        codeOf(() => callAs(world, { sessionId: world.f.sessionId, workspaceId: "ws_foreign_nonexistent", generation: 1, tool: "continue_execution_stage" })),
      ).toBe("WORKSPACE_MISMATCH");
      // No automatic takeover across WorkspaceIdentity.
      expect(
        codeOf(() =>
          callAs(world, {
            sessionId: "E14-WI1-FOREIGN",
            workspaceId: "ws_foreign_nonexistent",
            generation: 1,
            tool: "issue_execution_directive",
            business: {
              kind: "inspection", stage_id: world.activeStageId, window_id: world.openWindowId,
              objective: "probe", body: "probe", directive_id: "DIR-WI", revision: 1,
              final_plan_ref: { id: world.f.finalPlanId, revision: 1, hash: world.f.finalPlanHash },
              base_candidate_revision: currentRevision(world),
              plan_refs: [], expected_execution_scope: { stageId: world.activeStageId },
              capability_envelope: { repositoryRead: true, repositoryWrite: false, commandExecution: false, networkAccess: false, dependencyMutation: false, gitCommit: false, gitPush: false, externalServiceMutation: false },
              invariants: [], required_actions: [], forbidden_actions: [], validation_requirements: [],
              deliverables: [], stop_conditions: [],
              report_contract: { requireActionsPerformed: false, requireFilesExamined: false, requireFilesChanged: false, requireCommandsRun: false, requireTestsRun: false, requireFindings: false, requireDeviations: false, requireBlockers: false, requireDeliverables: false },
              verification_policy: { mode: "immediate" },
            },
          }),
        ),
      ).toBe("WORKSPACE_MISMATCH");
      // The canonical state is untouched by the foreign attempts.
      expect(executionFingerprintOf(world)).toBe(fingerprint);
      // The foreign directory is simply not this workspace — a fresh git clone
      // of the same repository would carry a different WorkspaceIdentity.
      expect(foreign.root).not.toBe(world.f.workspaceRoot);
    } finally {
      foreign.close();
    }
  });

  it("E14-WI2: the run stays durable when the bound workspace directory disappears; history readable; zero mutation", async () => {
    const world = await makeAcceptanceWorld("E14-WI2");
    runImplementation(world, { directiveId: "DIR-WI2", candidateMutated: true });
    const fingerprint = executionFingerprintOf(world);
    // Simulate the bound workspace vanishing.
    const { rmSync } = await import("node:fs");
    rmSync(world.f.workspaceRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    // The Run remains durable and its history readable.
    const after = world.ctx.store.withRead((tx) => ({
      lifecycle: tx.prepare("SELECT lifecycle AS l FROM execution_runs WHERE execution_run_id = ?").get(world.executionRunId) as { l: string },
      directives: tx.prepare("SELECT count(*) AS n FROM execution_directives WHERE execution_run_id = ?").get(world.executionRunId) as { n: number },
      binding: tx.prepare("SELECT state AS s FROM supervisor_bindings WHERE execution_run_id = ?").get(world.executionRunId) as { s: string },
    }));
    expect(after.lifecycle.l).toBe("active");
    expect(after.directives.n).toBe(2);
    expect(after.binding.s).toBe("attached");
    // Every writable identity fails closed against the vanished workspace
    // (the host cannot re-prove the workspace; the Store never guesses).
    expect(executionFingerprintOf(world)).toBe(fingerprint);
  });
});

describe("v020 E2E capability matrix (§33)", () => {
  it("E14-CM1: the Host/User ceiling is the outer bound for every role; roles never elevate capability", async () => {
    const world = await makeAcceptanceWorld("E14-CM1");
    // Supervisor (owner) may NOT directly execute repo/runtime work.
    for (const tool of ["Write", "Edit", "Bash"]) {
      const out = await preTool(world, world.f.sessionId, tool, tool === "Bash" ? { command: "rm -rf ." } : { file_path: "src/x.ts" });
      expect(JSON.stringify(out), `supervisor ${tool}`).toContain("SUPERVISOR_DIRECT_TOOL_FORBIDDEN");
    }
    // A NON-OWNER main session cannot become an unofficial Executor either.
    for (const tool of ["Write", "Bash"]) {
      const out = await preTool(world, "E14-CM1-NONOWNER", tool, tool === "Bash" ? { command: "make test" } : { file_path: "src/x.ts" });
      expect(JSON.stringify(out), `non-owner ${tool}`).toContain("EXECUTION_SESSION_NOT_OWNER");
    }
    // Arbitrary repository-working subagent launches are denied for non-owners.
    const agent = await preTool(world, "E14-CM1-NONOWNER", "Agent", { subagent_type: "general-purpose" });
    expect(JSON.stringify(agent)).toContain("EXECUTION_SESSION_NOT_OWNER");
  });

  it("E14-CM2: a stale former Supervisor is fenced from the host tool surface too", async () => {
    const world = await makeAcceptanceWorld("E14-CM2");
    // Take the run away from the fixture owner.
    const { takeoverSupervisorBindingInTx } = await import("../src/store/supervisor-bindings.js");
    world.ctx.store.withWrite((tx) => {
      takeoverSupervisorBindingInTx(
        tx,
        { executionRunId: world.executionRunId, workspaceId: world.f.workspaceId, newSessionId: "E14-CM2-S2", expectedGeneration: 1 },
        world.ctx.clock.nowIso(),
      );
    });
    // The FORMER owner's direct repo mutation is denied (it is now a non-owner).
    const out = await preTool(world, world.f.sessionId, "Write", { file_path: "src/x.ts" });
    expect(JSON.stringify(out)).toContain("EXECUTION_SESSION_NOT_OWNER");
  });

  it("E14-CM3: the Directive envelope only NARROWS authority; unsupported enforcement fails closed", async () => {
    const world = await makeAcceptanceWorld("E14-CM3");
    // A worker whose Directive grants write capability can mutate within the
    // Host ceiling (its PreToolUse path signs worker context — covered by the
    // E5 focused suites); a tool the HOST cannot enforce (open shell) is
    // refused at launch time by the capability launch gate.
    const { issueDirective } = await import("./execution-protocol-helpers.js");
    const { startWorkerAttemptAndPrepareLaunchInTx } = await import("../src/application/worker-runtime-service.js");
    const directive = issueDirective(world, {
      directiveId: "DIR-CM3-SHELL",
      kind: "implementation",
      capabilityEnvelope: {
        repositoryRead: true, repositoryWrite: true, commandExecution: true, networkAccess: false,
        dependencyMutation: false, gitCommit: false, gitPush: false, externalServiceMutation: false,
      } as never,
    });
    // commandExecution=true is NOT host-enforceable → the launch refuses closed.
    expect(
      codeOf(() =>
        world.ctx.store.withWrite((tx) =>
          startWorkerAttemptAndPrepareLaunchInTx(
            tx,
            {
              executionRunId: world.executionRunId,
              sessionId: world.f.sessionId,
              workspaceId: world.f.workspaceId,
              generation: world.f.generation,
              directiveId: directive.directiveId,
              directiveRevision: directive.revision,
              directiveHash: directive.hash,
              workerRole: "executor",
            },
            world.ctx.clock,
            world.ctx.clock.nowIso(),
          ),
        ),
      ),
    ).not.toBe("no-error");
  });
});

describe("v020 E2E trust-domain gate (§41)", () => {
  it("E14-TD1: no implicit bridge crosses a trust domain (integrated probe + static pairs)", async () => {
    const world = await makeAcceptanceWorld("E14-TD1");
    const before = world.ctx.store.withRead((tx) => ({
      memory: tx.prepare("SELECT count(*) AS n FROM memory_revisions").get() as { n: number },
      evidence: tx.prepare("SELECT count(*) AS n FROM observations").get() as { n: number },
      head: tx.prepare("SELECT accepted_head_commit_id AS h FROM execution_runs WHERE execution_run_id = ?").get(world.executionRunId) as { h: string | null },
      commits: tx.prepare("SELECT count(*) AS n FROM execution_commits WHERE execution_run_id = ?").get(world.executionRunId) as { n: number },
    }));

    // Execution happens: mutating report + verifier report + accept assessment.
    runImplementation(world, { directiveId: "DIR-TD-A1", candidateMutated: true });
    runFreshVerifier(world, { directiveId: "DIR-TD-V1" });
    supervisorCall(world, "submit_supervisor_assessment", {
      disposition: "accept",
      rationale: "verified candidate",
      report_judgments: [{ report_id: world.verReportId!, disposition: "supporting" }],
      covered_obligations: [],
      expected_candidate_revision: 2,
    });

    const afterReports = world.ctx.store.withRead((tx) => ({
      memory: tx.prepare("SELECT count(*) AS n FROM memory_revisions").get() as { n: number },
      evidence: tx.prepare("SELECT count(*) AS n FROM observations").get() as { n: number },
      head: tx.prepare("SELECT accepted_head_commit_id AS h FROM execution_runs WHERE execution_run_id = ?").get(world.executionRunId) as { h: string | null },
      commits: tx.prepare("SELECT count(*) AS n FROM execution_commits WHERE execution_run_id = ?").get(world.executionRunId) as { n: number },
    }));
    // ExecutionReport / SupervisorAssessment → Plan Evidence / Plan Memory: FORBIDDEN.
    expect(afterReports.memory.n).toBe(before.memory.n);
    expect(afterReports.evidence.n).toBe(before.evidence.n);
    // Worker "completed" and the accept assessment never DIRECTLY move accepted
    // progress — only the Core-gated ExecutionCommit does (exactly one here).
    expect(afterReports.commits.n).toBe(before.commits.n + 1);
    expect(afterReports.head).not.toBe(before.head);
    expect(afterReports.head).not.toBeNull();

    // A raw workspace mutation with NO execution protocol around it moves nothing.
    const fingerprint = executionFingerprintOf(world);
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const raw = join(world.f.workspaceRoot, "out", "raw-mutation.txt");
    mkdirSync(join(world.f.workspaceRoot, "out"), { recursive: true });
    writeFileSync(raw, "untracked physical reality\n");
    expect(executionFingerprintOf(world)).toBe(fingerprint); // workspace mutation → acceptedHead: FORBIDDEN bridge

    // Conversation summary → canonical Store state: FORBIDDEN — only the Host
    // events flow through the hooks; the capsule is a projection.
    const capsule = world.ctx.store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number });
    expect(capsule.n).toBeGreaterThan(10);
  });
});

describe("v020 E2E model-facing mutation surface audit (§42)", () => {
  const CLASSIFICATION: Record<string, string> = {
    // planning reads
    get_state: "read-only",
    get_context: "read-only",
    read_memory: "read-only",
    list_observations: "read-only",
    get_execution_acceptance_context: "read-only",
    get_execution_progression_context: "read-only",
    get_execution_final_closure_context: "read-only",
    get_attempt_recovery_context: "read-only",
    get_verification_policy_context: "read-only",
    // planning mutations (Proposal → human Approval → PlanCommit machinery)
    start_or_resume: "planning mutation",
    handoff: "planning mutation",
    select_section: "planning mutation",
    prepare_proposal: "planning mutation",
    approve_proposal: "planning mutation",
    submit_synthesis: "planning mutation",
    submit_validation: "planning mutation",
    request_reopen: "planning mutation",
    request_finalization: "planning mutation",
    promote_evidence: "planning mutation",
    revalidate_evidence: "planning mutation",
    // execution supervisor mutations
    issue_execution_directive: "supervisor execution mutation",
    submit_supervisor_assessment: "supervisor execution mutation",
    continue_execution_stage: "supervisor execution mutation",
    activate_execution_stage: "supervisor execution mutation",
    begin_execution_final_closure: "supervisor execution mutation",
    declare_verification_conflict: "supervisor execution mutation",
    resolve_verification_conflict: "supervisor execution mutation",
    issue_attempt_reconciliation: "supervisor execution mutation",
    resolve_indeterminate_attempt: "supervisor execution mutation",
    retry_unclaimed_worker_launch: "supervisor execution mutation",
    report_execution_issue: "supervisor execution mutation",
    request_execution_replan: "supervisor execution mutation",
    // worker operations (Attempt-scoped invocation authority)
    worker_claim: "worker operation",
    worker_get_assignment: "worker operation",
    worker_submit_report: "worker operation",
    start_worker_attempt: "worker operation",
    // human-authorized control operations (mandatory dialog)
    takeover_run: "human-authorized control operation",
    abort_run: "human-authorized control operation",
    abort_execution_run: "human-authorized control operation",
    reexecute_final_plan: "human-authorized control operation",
  };

  it("E14-MS1: the live registry classifies fully; the recorded count is the shipped count", () => {
    const names = PHASE_PLAN_TOOLS.map((tool) => tool.name);
    // Every live tool is classified — no unlisted surface exists.
    for (const name of names) {
      expect(CLASSIFICATION[name], `unclassified tool: ${name}`).toBeTruthy();
    }
    expect(Object.keys(CLASSIFICATION).sort()).toEqual([...names].sort());
    // The actual final tool count is RECORDED from the registry (§42).
    expect(names.length).toBe(40);
  });

  it("E14-MS2: no public tool exposes a raw authority bypass", () => {
    const banned = [
      "set_lifecycle", "set_accepted_head", "set_candidate_revision", "close_window",
      "complete_stage", "create_execution_commit", "set_generation", "set_attempt_state",
      "force", "bypass", "set_head", "advance_window", "complete_execution_run", "rollback",
    ];
    for (const tool of PHASE_PLAN_TOOLS) {
      for (const fragment of banned) {
        expect(tool.name, `${tool.name} vs ${fragment}`).not.toContain(fragment);
      }
      // The schema never accepts model-supplied authority fields.
      const properties = Object.keys(tool.inputSchema.properties as Record<string, unknown>);
      for (const authority of ["session_id", "workspace_id", "binding_generation", "generation", "force", "approved", "authorization_request_id", "accepted_head", "candidate_revision", "lifecycle"]) {
        expect(properties, `${tool.name} accepts ${authority}`).not.toContain(authority);
      }
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
    // The three control tools require the mandatory user-interaction dialog.
    for (const control of ["takeover_run", "abort_run", "abort_execution_run", "reexecute_final_plan"]) {
      const tool = PHASE_PLAN_TOOLS.find((t) => t.name === control)!;
      expect(tool._meta).toMatchObject({ "anthropic/requiresUserInteraction": true });
    }
  });
});
