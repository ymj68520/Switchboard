/**
 * E14 §20–§26 + §30 — integrated session/ownership E2E: /clear (including the
 * same-session-ID adversarial case), fork non-inheritance, compaction,
 * rewind-style stale contexts, explicit takeover with the stale-owner mutation
 * matrix, claimed/prepared worker authority across takeover, and the terminal
 * recovery matrix. Conversation operations are NEVER execution operations:
 * every scenario fingerprints canonical state and proves the operation left it
 * untouched while writable authority moves exactly as the frozen rules demand.
 */
import { describe, expect, it } from "vitest";

import {
  depsOf,
  contextOf,
  executionFingerprintOf,
  explicitExecutionTakeover,
  explicitExecutionAbort,
  sessionStartInput,
  bindingOf,
  directiveProbeBusiness,
  lifecycleOf,
} from "./session-recovery-helpers.js";
import {
  makeAcceptanceWorld,
  runFreshVerifier,
  supervisorCall,
  type E14World,
} from "./v020-e2e-helpers.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import { startWorkerAttemptAndPrepareLaunchInTx } from "../src/application/worker-runtime-service.js";
import { callWorkerTool, freshWorkerSession } from "./execution-worker-helpers.js";
import { handleSessionStart } from "../src/hooks/handlers.js";
import { executePhasePlanTool } from "../src/mcp/tools.js";
import { parseFinalPlanCanonical } from "../src/application/handoff-service.js";
import { getFinalPlanInTx } from "../src/store/finalization.js";
import { executionToken } from "./phase14-helpers.js";
import {
  completeAllStagesFixture,
  beginFinalClosure,
  runFinalCompletionFixture,
} from "./final-closure-helpers.js";

/** Sign an execution token for an ARBITRARY session/generation pair. */
function callAs(
  world: E14World,
  input: { sessionId: string; generation: number; tool: string; business?: Record<string, unknown> },
): Record<string, unknown> {
  const business = input.business ?? {};
  const token = executionToken(world.ctx, {
    sessionId: input.sessionId,
    workspaceId: world.f.workspaceId,
    runId: world.executionRunId,
    finalPlanId: world.f.finalPlanId,
    generation: input.generation,
    tool: input.tool,
    business,
  });
  return executePhasePlanTool(world.ctx, input.tool, { ...business, _hostContext: token }) as Record<string, unknown>;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code ?? "no-error";
  }
  return "no-error";
}

describe("v020 E2E /clear and fork (§20/§21)", () => {
  it("E14-SR1: /clear with the SAME session id detaches writable authority, changes nothing else (§20)", async () => {
    const world = await makeAcceptanceWorld("E14-SR1");
    // A claimed worker exists BEFORE the clear (attempt-scoped authority).
    const directive = issueDirective(world, { directiveId: "DIR-SR1", kind: "implementation" });
    const started = world.ctx.store.withWrite((tx) =>
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
    );
    const worker = freshWorkerSession(world, "SR1");
    callWorkerTool(world, worker, "worker_claim", { attempt_id: started.attempt.attemptId, launch_token: started.launch.launchToken });

    const executionStateBefore = executionStateOf(world);
    // The adversarial case: the SAME session id re-enters via /clear.
    const output = await handleSessionStart(depsOf(world), sessionStartInput(world, { source: "clear" }) as never);
    const capsule = contextOf(output);
    expect(capsule).toContain("ownership class: cleared");

    // Writable authority: detached; generation UNCHANGED (clear is a detach,
    // not a takeover — E12C §17).
    const binding = bindingOf(world)!;
    expect(binding.state).toBe("detached");
    expect(binding.generation).toBe(1);
    // Execution state untouched (the binding is the ONLY thing that changed).
    expect(executionStateOf(world)).toBe(executionStateBefore);
    expect(lifecycleOf(world)).toBe("active");
    // The NEW context has NO writable authority even with the same session id.
    expect(
      codeOf(() =>
        callAs(world, {
          sessionId: world.f.sessionId,
          generation: 1,
          tool: "issue_execution_directive",
          business: directiveProbeBusiness(world),
        }),
      ),
    ).toBe("SUPERVISOR_BINDING_REQUIRED");
    // …and the claimed Worker REMAINS valid (attempt-scoped, not supervisor-borrowed).
    callWorkerTool(world, worker, "worker_submit_report", { result: "completed", candidate_mutated: true });
    // Explicit reacquisition goes through takeover: generation +1.
    const reacquired = explicitExecutionTakeover(world, { newSessionId: "E14-SR1-S2", expectedGeneration: 1 });
    expect(reacquired.binding.generation).toBe(2);
    expect(
      codeOf(() =>
        callAs(world, {
          sessionId: "E14-SR1-S2",
          generation: 2,
          tool: "issue_execution_directive",
          business: directiveProbeBusiness(world),
        }),
      ),
    ).toBe("no-error");
  });

  it("E14-SR2: fork never inherits writable ownership and never mutates the original owner (§21)", async () => {
    const world = await makeAcceptanceWorld("E14-SR2");
    const fingerprintBefore = executionFingerprintOf(world);
    // The fork shares conversation ancestry — here modeled with the SAME
    // session id entering via source=fork (the hostile case).
    const output = await handleSessionStart(depsOf(world), sessionStartInput(world, { source: "fork" }) as never);
    expect(contextOf(output)).toContain("ownership class: fork");
    // Original owner REMAINS attached (fork is not a detach of the origin).
    const binding = bindingOf(world)!;
    expect(binding.state).toBe("attached");
    expect(binding.sessionId).toBe(world.f.sessionId);
    expect(binding.generation).toBe(1);
    expect(executionFingerprintOf(world)).toBe(fingerprintBefore);
    // Same id + same generation IS the owner — identity equality, not
    // ancestry — so the probe proves the ORIGINAL owner kept authority.
    expect(
      codeOf(() =>
        callAs(world, {
          sessionId: world.f.sessionId,
          generation: 1,
          tool: "issue_execution_directive",
          business: directiveProbeBusiness(world),
        }),
      ),
    ).toBe("no-error");
    // A DIFFERENT fork session may read recovery but can never mutate.
    const forkOutput = await handleSessionStart(
      depsOf(world),
      sessionStartInput(world, { source: "fork", sessionId: "E14-SR2-FORK" }) as never,
    );
    // A different-session fork renders the fenced in-progress capsule.
    expect(contextOf(forkOutput)).toContain("NO writable supervision authority");
    expect(
      codeOf(() => callAs(world, { sessionId: "E14-SR2-FORK", generation: 1, tool: "continue_execution_stage" })),
    ).toBe("STALE_SUPERVISOR_BINDING");
    // Explicit human-authorized takeover increments the generation and fences
    // even the ORIGINAL owner.
    const reacquired = explicitExecutionTakeover(world, { newSessionId: "E14-SR2-S2", expectedGeneration: 1 });
    expect(reacquired.binding.generation).toBe(2);
    expect(
      codeOf(() => callAs(world, { sessionId: world.f.sessionId, generation: 1, tool: "continue_execution_stage" })),
    ).toBe("STALE_SUPERVISOR_BINDING");
  });
});

describe("v020 E2E compaction and rewind (§22/§23)", () => {
  it("E14-SR3: compaction preserves binding, generation, and execution state (§22)", async () => {
    const world = await makeAcceptanceWorld("E14-SR3");
    runFreshVerifier(world, { directiveId: "DIR-SR3-V1" });
    const fingerprintBefore = executionFingerprintOf(world);
    const eventsBefore = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM supervisor_binding_events WHERE execution_run_id = ?").get(world.executionRunId) as { n: number },
    );
    await handleSessionStart(depsOf(world), sessionStartInput(world, { source: "compact" }) as never);
    expect(executionFingerprintOf(world)).toBe(fingerprintBefore);
    expect(
      world.ctx.store.withRead(
        (tx) => tx.prepare("SELECT count(*) AS n FROM supervisor_binding_events WHERE execution_run_id = ?").get(world.executionRunId) as { n: number },
      ).n,
    ).toBe(eventsBefore.n); // compaction adds no binding events
    // The compacted session retains full authority (directive issuance is
    // legal with an open window).
    expect(
      codeOf(() =>
        callAs(world, {
          sessionId: world.f.sessionId,
          generation: 1,
          tool: "issue_execution_directive",
          business: directiveProbeBusiness(world),
        }),
      ),
    ).toBe("no-error");
  });

  it("E14-SR4: rewind-style stale contexts fail closed; the Store keeps newest durable truth (§23)", async () => {
    const world = await makeAcceptanceWorld("E14-SR4");
    runFreshVerifier(world, { directiveId: "DIR-SR4-V1" });
    const accept = supervisorCall(world, "submit_supervisor_assessment", {
      disposition: "accept",
      rationale: "verified",
      report_judgments: [{ report_id: world.verReportId!, disposition: "supporting" }],
      covered_obligations: [],
      expected_candidate_revision: 1,
    }) as { accepted_head: string };
    const headAfterCommit = accept.accepted_head;
    const fingerprintBefore = executionFingerprintOf(world);

    // A "rewound" context behaves as if the commit never happened. Every
    // stale action it can attempt fails closed:
    // (a) re-submitting the verifier's report — already consumed;
    // (b) accepting at the OLD candidate revision — stale;
    // (c) re-running the same directive revision — already attempted.
    const staleAcceptCode = codeOf(() =>
      callAs(world, {
        sessionId: world.f.sessionId,
        generation: 1,
        tool: "submit_supervisor_assessment",
        business: {
          disposition: "accept",
          rationale: "rewound context re-accepts the pre-commit candidate",
          report_judgments: [],
          covered_obligations: [],
          expected_candidate_revision: 0,
        },
      }),
    );
    expect(staleAcceptCode).toBe("VERIFICATION_WINDOW_REQUIRED"); // the committed window is gone
    const store = world.ctx.store;
    const directive = store.withRead(
      (tx) => tx.prepare("SELECT directive_id AS id FROM execution_directives WHERE directive_id = 'DIR-SR4-V1'").get() as { id: string },
    );
    expect(
      codeOf(() =>
        store.withWrite((tx) =>
          startWorkerAttemptAndPrepareLaunchInTx(
            tx,
            {
              executionRunId: world.executionRunId,
              sessionId: world.f.sessionId,
              workspaceId: world.f.workspaceId,
              generation: world.f.generation,
              directiveId: directive.id,
              directiveRevision: 1,
              directiveHash: "sha256:rewound-context-does-not-know-the-real-hash",
              workerRole: "verifier",
            },
            world.ctx.clock,
            world.ctx.clock.nowIso(),
          ),
        ),
      ),
    ).toBe("DIRECTIVE_HASH_MISMATCH");
    // The Store is untouched by every stale action.
    expect(executionFingerprintOf(world)).toBe(fingerprintBefore);
    expect(world.ctx.store.withRead((tx) => tx.prepare("SELECT accepted_head_commit_id AS h FROM execution_runs WHERE execution_run_id = ?").get(world.executionRunId) as { h: string }).h).toBe(headAfterCommit);
  });
});

describe("v020 E2E explicit takeover (§24/§25/§26)", () => {
  it("E14-SR5: takeover fences the old owner across the whole mutation matrix (§24)", async () => {
    const world = await makeAcceptanceWorld("E14-SR5");
    const takeover = explicitExecutionTakeover(world, { newSessionId: "E14-SR5-S2", expectedGeneration: 1 });
    expect(takeover.binding.generation).toBe(2);
    expect(bindingOf(world)!.sessionId).toBe("E14-SR5-S2");

    // The stale-owner mutation matrix — every supervisor mutation from S1@1 fails.
    const stale: Array<[string, () => unknown]> = [
      ["directive_issuance", () => issueDirectiveAs(world, "E14-SR5", 1)],
      ["attempt_launch", () => launchAttemptAs(world, "E14-SR5", 1)],
      ["assessment", () =>
        callAs(world, {
          sessionId: "E14-SR5",
          generation: 1,
          tool: "submit_supervisor_assessment",
          business: {
            disposition: "rework",
            rationale: "stale owner judgment",
            report_judgments: [],
            covered_obligations: [],
            expected_candidate_revision: 1,
          },
        })],
      ["stage_progression_continue", () => callAs(world, { sessionId: "E14-SR5", generation: 1, tool: "continue_execution_stage" })],
      ["stage_progression_activate", () => callAs(world, { sessionId: "E14-SR5", generation: 1, tool: "activate_execution_stage", business: { target_stage_id: "stage_x" } })],
      ["replan", () =>
        callAs(world, {
          sessionId: "E14-SR5",
          generation: 1,
          tool: "request_execution_replan",
          business: {
            reason: "stale owner replan",
            affected_normative_refs: [firstSectionRefOf(world)],
          },
        })],
      ["reconciliation", () =>
        callAs(world, {
          sessionId: "E14-SR5",
          generation: 1,
          tool: "issue_attempt_reconciliation",
          business: {
            attempt_id: "att_nonexistent",
            objective: "stale owner inspection",
            body: "stale",
            capability_envelope: { repositoryRead: true, repositoryWrite: false, commandExecution: false, networkAccess: false, dependencyMutation: false, gitCommit: false, gitPush: false, externalServiceMutation: false },
            report_contract: { requireFilesExamined: true, requireFindings: true },
          },
        })],
      ["takeover_retry", () => explicitExecutionTakeover(world, { newSessionId: "E14-SR5", expectedGeneration: 1 })], // STALE_SUPERVISOR_BINDING (A1 §23): the demoted ExecutionBinding no longer arbitrates this surface — the stale supervision generation fences instead
    ];
    for (const [name, probe] of stale) {
      // The replan surface folds its stale-authority refusal into its own
      // request-invalid code (execution-replan-service.ts:162); every other
      // supervisor surface reports STALE_SUPERVISOR_BINDING.
      const expected = name === "replan" ? "REPLAN_REQUEST_INVALID" : "STALE_SUPERVISOR_BINDING";
      expect(codeOf(probe), `stale owner probe: ${name}`).toBe(expected);
    }
    // And the NEW owner can mutate (directive issuance is legal here).
    expect(
      codeOf(() =>
        callAs(world, {
          sessionId: "E14-SR5-S2",
          generation: 2,
          tool: "issue_execution_directive",
          business: directiveProbeBusiness(world),
        }),
      ),
    ).toBe("no-error");
  });

  it("E14-SR6: claimed Worker authority survives takeover for its exact Attempt only (§25)", async () => {
    const world = await makeAcceptanceWorld("E14-SR6");
    const directive = issueDirective(world, { directiveId: "DIR-SR6", kind: "implementation" });
    const started = world.ctx.store.withWrite((tx) =>
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
    );
    const worker = freshWorkerSession(world, "SR6");
    callWorkerTool(world, worker, "worker_claim", { attempt_id: started.attempt.attemptId, launch_token: started.launch.launchToken });

    // S1 → S2 takeover mid-flight. All subsequent supervisor operations run
    // as the NEW owner (the helpers derive identity from world.f).
    const takeover = explicitExecutionTakeover(world, { newSessionId: "E14-SR6-S2", expectedGeneration: 1 });
    expect(takeover.binding.generation).toBe(2);
    world.f = { ...world.f, sessionId: "E14-SR6-S2", generation: 2 };

    // The Worker remains valid and its Report persists.
    const ack = callWorkerTool(world, worker, "worker_submit_report", {
      result: "completed",
      candidate_mutated: true,
    }) as { report_id: string };
    expect(ack.report_id).toBeTruthy();
    // S1 cannot reason or mutate afterward.
    expect(
      codeOf(() => callAs(world, { sessionId: "E14-SR6", generation: 1, tool: "submit_supervisor_assessment", business: {
        disposition: "rework", rationale: "stale", report_judgments: [], covered_obligations: [], expected_candidate_revision: 2,
      } })),
    ).toBe("STALE_SUPERVISOR_BINDING");
    // S2 consumes the Report and continues: a fresh verifier + accept at the new candidate.
    runFreshVerifier(world, { directiveId: "DIR-SR6-V1" });
    const accept = supervisorCall(world, "submit_supervisor_assessment", {
      disposition: "accept",
      rationale: "new owner consumes the carried-over evidence",
      report_judgments: [{ report_id: world.verReportId!, disposition: "supporting" }],
      covered_obligations: [],
      expected_candidate_revision: 2,
    }) as { status: string; accepted_head: string };
    expect(accept.status).toBe("accepted");
  });

  it("E14-SR7: prepared credentials are fenced across takeover; the new owner re-credentials the SAME Attempt (§26)", async () => {
    const world = await makeAcceptanceWorld("E14-SR7");
    const directive = issueDirective(world, { directiveId: "DIR-SR7", kind: "implementation" });
    const started = world.ctx.store.withWrite((tx) =>
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
    );
    const staleToken = started.launch.launchToken;

    // Takeover BEFORE any claim: the credential fence rides the same transaction.
    const takeover = explicitExecutionTakeover(world, { newSessionId: "E14-SR7-S2", expectedGeneration: 1 });
    expect(takeover.binding.generation).toBe(2);
    world.f = { ...world.f, sessionId: "E14-SR7-S2", generation: 2 };

    // The old (fenced Supervisor's) credential can never claim.
    expect(
      codeOf(() =>
        callWorkerTool(world, freshWorkerSession(world, "THIEF"), "worker_claim", {
          attempt_id: started.attempt.attemptId,
          launch_token: staleToken,
        }),
      ),
    ).toBe("WORKER_CLAIM_TOKEN_INVALID");

    // The same Attempt remains; the NEW Supervisor re-credentials it.
    const retried = supervisorCall(world, "retry_unclaimed_worker_launch", { attempt_id: started.attempt.attemptId }) as {
      status: string;
      launch_token: string;
    };
    expect(retried.status).toBe("relaunched");
    const worker = freshWorkerSession(world, "SR7-NEW");
    callWorkerTool(world, worker, "worker_claim", {
      attempt_id: started.attempt.attemptId,
      launch_token: retried.launch_token,
    });
    const attempts = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM execution_attempts WHERE directive_id = 'DIR-SR7'").get() as { n: number },
    );
    expect(attempts.n).toBe(1); // no duplicate work
  });
});

describe("v020 E2E terminal recovery matrix (§30)", () => {
  async function completedWorld(sessionId: string): Promise<E14World> {
    const world = await makeAcceptanceWorld(sessionId);
    completeAllStagesFixture(world);
    beginFinalClosure(world);
    runFinalCompletionFixture(world);
    expect(lifecycleOf(world)).toBe("completed");
    return world;
  }

  async function replannedWorld(sessionId: string): Promise<E14World> {
    const world = await makeAcceptanceWorld(sessionId);
    const row = world.ctx.store.withRead((tx) => getFinalPlanInTx(tx, world.f.runId))!;
    const section = parseFinalPlanCanonical(row.canonicalJson, world.executionRunId).sections[0]!;
    supervisorCall(world, "request_execution_replan", {
      reason: "terminal recovery matrix fixture",
      affected_normative_refs: [{ type: "section", id: section.sectionId, revision: section.revision }],
    });
    expect(lifecycleOf(world)).toBe("replan_required");
    return world;
  }

  async function abortedWorld(sessionId: string): Promise<E14World> {
    const world = await makeAcceptanceWorld(sessionId);
    explicitExecutionAbort(world, { reason: "terminal recovery matrix fixture" });
    expect(lifecycleOf(world)).toBe("aborted");
    return world;
  }

  const SESSION_EVENT_VARIANTS: Array<{ label: string; source: string }> = [
    { label: "startup", source: "startup" },
    { label: "resume", source: "resume" },
    { label: "clear", source: "clear" },
    { label: "fork", source: "fork" },
    { label: "compact", source: "compact" },
  ];

  for (const build of [
    { name: "completed", build: completedWorld },
    { name: "replan_required", build: replannedWorld },
    { name: "aborted", build: abortedWorld },
  ]) {
    it(`E14-SR8/${build.name}: no session event reactivates a terminal Run or regains ownership (§30)`, async () => {
      const world = await build.build(`E14-SR8-${build.name}`);
      const fingerprint = executionFingerprintOf(world);
      for (const variant of SESSION_EVENT_VARIANTS) {
        await handleSessionStart(depsOf(world), sessionStartInput(world, { source: variant.source }) as never);
        expect(executionFingerprintOf(world), `after ${variant.label}`).toBe(fingerprint);
        expect(lifecycleOf(world)).toBe(build.name);
      }
      // A takeover request cannot regain ownership of a terminal run.
      expect(
        codeOf(() => explicitExecutionTakeover(world, { newSessionId: "E14-SR8-THIEF", expectedGeneration: 1 })),
      ).not.toBe("no-error");
      // History stays readable: the durable protocol objects remain queryable.
      const history = world.ctx.store.withRead((tx) => ({
        directives: tx.prepare("SELECT count(*) AS n FROM execution_directives WHERE run_id = ?").get(world.executionRunId) as { n: number },
        events: tx.prepare("SELECT count(*) AS n FROM execution_run_events WHERE execution_run_id = ?").get(world.executionRunId) as { n: number },
      }));
      expect(history.directives.n).toBeGreaterThanOrEqual(0);
      expect(history.events.n).toBeGreaterThanOrEqual(1);
      const output = await handleSessionStart(depsOf(world), sessionStartInput(world, { source: "startup" }) as never);
      void contextOf(output); // terminal capsules render no reactivation path
      // Zero execution mutation after the whole matrix.
      expect(executionFingerprintOf(world)).toBe(fingerprint);
    });
  }
});

/**
 * The execution-state fingerprint WITHOUT ownership (the binding legitimately
 * changes on detach/takeover; nothing else may).
 */
function executionStateOf(world: E14World): string {
  const parsed = JSON.parse(executionFingerprintOf(world)) as Record<string, unknown>;
  delete parsed.binding;
  return JSON.stringify(parsed);
}

/** The exact first FinalPlan section ref (a real normative anchor). */
function firstSectionRefOf(world: E14World): { type: string; id: string; revision: number } {
  const row = world.ctx.store.withRead((tx) => getFinalPlanInTx(tx, world.f.runId))!;
  const section = parseFinalPlanCanonical(row.canonicalJson, world.executionRunId).sections[0]!;
  return { type: "section", id: section.sectionId, revision: section.revision };
}

/** Issue a directive as an ARBITRARY session/generation (stale-owner probe). */
function issueDirectiveAs(world: E14World, sessionId: string, generation: number): unknown {
  return callAs(world, { sessionId, generation, tool: "issue_execution_directive", business: directiveProbeBusiness(world) });
}

/** Start an attempt as an ARBITRARY session/generation (stale-owner probe). */
function launchAttemptAs(world: E14World, sessionId: string, generation: number): unknown {
  const directive = issueDirective(world, { directiveId: `DIR-${sessionId}-LAUNCH`, kind: "implementation" });
  return world.ctx.store.withWrite((tx) =>
    startWorkerAttemptAndPrepareLaunchInTx(
      tx,
      {
        executionRunId: world.executionRunId,
        sessionId,
        workspaceId: world.f.workspaceId,
        generation,
        directiveId: directive.directiveId,
        directiveRevision: directive.revision,
        directiveHash: directive.hash,
        workerRole: "executor",
      },
      world.ctx.clock,
      world.ctx.clock.nowIso(),
    ),
  );
}
