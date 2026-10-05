/**
 * v0.2.0 E5 — role independence + supervisor boundary (E5 §53/§54 focused
 * tests T13–T21), and the no-E6-artifacts scan (T52).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { handlePreToolUse, type HookHandlerDeps } from "../src/hooks/handlers.js";
import { getWorkerInvocationInTx } from "../src/store/worker-invocations.js";
import { getExecutionAttemptInTx } from "../src/store/execution-attempts.js";
import {
  callWorkerTool,
  freshWorkerSession,
  makeWorkerWorld,
  codeOf,
  type WorkerWorld,
} from "./execution-worker-helpers.js";
import { hostTokenV2, executionToken } from "./phase14-helpers.js";

function outputOf(output: Awaited<ReturnType<typeof handlePreToolUse>>): { decision: string | null; reason: string } {
  if (output.kind !== "json") return { decision: null, reason: "" };
  const specific = (output.payload as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
  return { decision: specific?.permissionDecision ?? null, reason: specific?.permissionDecisionReason ?? "" };
}

async function claimWorker(w: WorkerWorld, name = "W1") {
  const session = freshWorkerSession(w, name);
  callWorkerTool(w, session, "worker_claim", {
    attempt_id: w.attempt.attemptId,
    launch_token: w.launch.launchToken,
  });
  return session;
}

describe("v0.2.0 E5 — role independence (T13–T16)", () => {
  it("T13: executor and verifier use the SAME invocation/claim/assignment/report protocol", async () => {
    const executorWorld = await makeWorkerWorld("S1", { kind: "implementation" });
    try {
      const sessionE = await claimWorker(executorWorld, "E1");
      const assignmentE = callWorkerTool(executorWorld, sessionE, "worker_get_assignment", {});
      expect(assignmentE.worker_role).toBe("executor");
      callWorkerTool(executorWorld, sessionE, "worker_submit_report", { result: "completed", candidate_mutated: false });
      // Same runtime machinery drives the verifier (fresh world — one running attempt per run).
      const verifierWorld = await makeWorkerWorld("S2", { kind: "verification" });
      try {
        const sessionV = await claimWorker(verifierWorld, "V1");
        const assignmentV = callWorkerTool(verifierWorld, sessionV, "worker_get_assignment", {});
        expect(assignmentV.worker_role).toBe("verifier");
        const resultV = callWorkerTool(verifierWorld, sessionV, "worker_submit_report", {
          result: "completed",
          candidate_mutated: false,
          tests_run: [{ name: "suite", outcome: "pass", detail: null }],
        });
        expect(resultV.status).toBe("reported");
        // Identical surfaces, identical persistence.
        expect(Object.keys(assignmentE).sort()).toEqual(Object.keys(assignmentV).sort());
      } finally {
        verifierWorld.ctx.store.close();
      }
    } finally {
      executorWorld.ctx.store.close();
    }
  });

  it("T14/T15: every verification (and executor) attempt launches a FRESH worker session identity", async () => {
    const first = await makeWorkerWorld("S1", { kind: "verification" });
    try {
      const sessionA = await claimWorker(first, "VA");
      callWorkerTool(first, sessionA, "worker_submit_report", {
        result: "completed",
        candidate_mutated: true,
        tests_run: [{ name: "suite", outcome: "pass", detail: null }],
      });
      // Second verification attempt (new directive + attempt) — fresh spawn.
      const service = await import("../src/application/execution-directive-service.js");
      const { startWorkerAttemptAndPrepareLaunchInTx } = await import("../src/application/worker-runtime-service.js");
      const directive = service.createExecutionDirectiveService(first.ctx.store, first.ctx.clock).issueExecutionDirective(
        (await import("./execution-protocol-helpers.js")).directiveInput(first, {
          directiveId: "DIR-W2",
          kind: "verification",
          objective: "verify after mutation",
        }),
      );
      const { attempt, launch } = first.ctx.store.withWrite((tx) =>
        startWorkerAttemptAndPrepareLaunchInTx(tx, {
          executionRunId: first.executionRunId,
          sessionId: first.f.sessionId,
          workspaceId: first.f.workspaceId,
          generation: first.f.generation,
          directiveId: directive.directiveId,
          directiveRevision: directive.revision,
          directiveHash: directive.hash,
          workerRole: "verifier",
        }, first.ctx.clock, first.ctx.clock.nowIso()),
      );
      const sessionB = freshWorkerSession(first, "VB");
      callWorkerTool(first, sessionB, "worker_claim", {
        attempt_id: attempt.attemptId,
        launch_token: launch.launchToken,
      });
      const bindingB = first.ctx.store.withRead((tx) => getWorkerInvocationInTx(tx, attempt.attemptId));
      expect(bindingB!.workerSessionId).toBe(sessionB.sessionId);
      expect(sessionB.sessionId).not.toBe(sessionA.sessionId);
      // Executor policy: also fresh per attempt (documented E5 §7 implementation policy).
      expect(bindingB!.attemptId).not.toBe(first.attempt.attemptId);
    } finally {
      first.ctx.store.close();
    }
  });

  it("T16: role does not change the technical tool surface — the Directive envelope does", async () => {
    const w = await makeWorkerWorld("S1", { kind: "verification" });
    try {
      const { narrowWorkerTool } = await import("../src/runtime/worker-capabilities.js");
      const envelope = w.directive.capabilityEnvelope;
      // Same classification for both roles: only the envelope decides.
      expect(narrowWorkerTool("Read", envelope).allowed).toBe(envelope.repositoryRead);
      expect(narrowWorkerTool("Edit", envelope).allowed).toBe(envelope.repositoryWrite);
      const verifierEnvelope = { ...envelope };
      expect(narrowWorkerTool("Read", verifierEnvelope).allowed).toBe(narrowWorkerTool("Read", envelope).allowed);
      // The worker's claimed authority is attempt-scoped either way.
      const session = await claimWorker(w, "V1");
      const binding = w.ctx.store.withRead((tx) => getWorkerInvocationInTx(tx, w.attempt.attemptId));
      expect(binding!.workerRole).toBe("verifier");
      void session;
    } finally {
      w.ctx.store.close();
    }
  });
});

describe("v0.2.0 E5 — supervisor boundary (T17–T21)", () => {
  function depsOf(w: WorkerWorld): HookHandlerDeps {
    return { store: w.ctx.store, secret: w.ctx.secret, clock: w.ctx.clock };
  }

  function supervisorPreToolUse(w: WorkerWorld, toolName: string, toolInput: Record<string, unknown> = {}) {
    return handlePreToolUse(depsOf(w), {
      sessionId: w.f.sessionId,
      cwd: w.f.workspaceRoot,
      permissionMode: "default",
      hookEventName: "PreToolUse",
      toolName,
      toolInput,
      toolUseId: "TU-SUPERVISOR",
    });
  }

  it("T17/T18/T19: the active supervisor's direct read/write/shell tools are denied", async () => {
    const w = await makeWorkerWorld();
    try {
      for (const tool of ["Read", "Grep", "Edit", "Write", "Bash"]) {
        const output = await supervisorPreToolUse(w, tool, tool === "Bash" ? { command: "ls" } : { file_path: "x" });
        const { decision, reason } = outputOf(output);
        expect(decision, tool).toBe("deny");
        expect(reason, tool).toContain("SUPERVISOR_DIRECT_TOOL_FORBIDDEN");
      }
    } finally {
      w.ctx.store.close();
    }
  });

  it("T20: the supervisor can still perform the approved worker-launch operation", async () => {
    const w = await makeWorkerWorld();
    try {
      // issue_execution_directive via the real dispatcher with an EXECUTION supervisor token.
      const token = executionToken(w.ctx, {
        sessionId: w.f.sessionId,
        workspaceId: w.f.workspaceId,
        runId: w.executionRunId,
        finalPlanId: w.f.finalPlanId,
        generation: w.f.generation,
        tool: "issue_execution_directive",
        toolUseId: "TU-ISSUE",
        business: {
          kind: "inspection",
          stage_id: w.activeStageId,
          window_id: w.openWindowId,
          objective: "Inspect the change",
          body: "Look.",
          capability_envelope: {
            repositoryRead: true, repositoryWrite: false, commandExecution: false, networkAccess: false,
            dependencyMutation: false, gitCommit: false, gitPush: false, externalServiceMutation: false,
          },
          report_contract: {
            requireActionsPerformed: false, requireFilesExamined: false, requireFilesChanged: false,
            requireCommandsRun: false, requireTestsRun: false, requireFindings: false,
            requireDeviations: false, requireBlockers: false, requireDeliverables: false,
          },
        },
      });
      const { executePhasePlanTool } = await import("../src/mcp/tools.js");
      const result = executePhasePlanTool(w.ctx, "issue_execution_directive", {
        kind: "inspection",
        stage_id: w.activeStageId,
        window_id: w.openWindowId,
        objective: "Inspect the change",
        body: "Look.",
        capability_envelope: {
          repositoryRead: true, repositoryWrite: false, commandExecution: false, networkAccess: false,
          dependencyMutation: false, gitCommit: false, gitPush: false, externalServiceMutation: false,
        },
        report_contract: {
          requireActionsPerformed: false, requireFilesExamined: false, requireFilesChanged: false,
          requireCommandsRun: false, requireTestsRun: false, requireFindings: false,
          requireDeviations: false, requireBlockers: false, requireDeliverables: false,
        },
        _hostContext: token,
      }) as Record<string, unknown>;
      expect(result.status).toBe("issued");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T21: an arbitrary subagent launch cannot bypass the worker protocol", async () => {
    const w = await makeWorkerWorld();
    try {
      // Generic Agent-tool launch during supervised execution: denied...
      const generic = await supervisorPreToolUse(w, "Task", { subagent_type: "general-purpose", prompt: "work" });
      expect(outputOf(generic).decision).toBe("deny");
      expect(outputOf(generic).reason).toContain("SUPERVISOR_DIRECT_TOOL_FORBIDDEN");
      // ...while the approved execution-worker launch path stays open.
      const workerLaunch = await supervisorPreToolUse(w, "Task", {
        subagent_type: "phase-plan:execution-worker",
        prompt: "claim and execute",
      });
      expect(outputOf(workerLaunch).decision).toBeNull();
      // A non-worker subagent can never claim worker authority either.
      const session = { sessionId: "sub-1", agentId: "a1", workspaceId: w.f.workspaceId };
      const foreignToken = hostTokenV2(w.ctx.secret, "worker_claim", {}, {
        sessionId: session.sessionId,
        workspaceId: session.workspaceId,
        runId: w.executionRunId,
        generation: w.f.generation,
      }, { toolUseId: "TU-FOREIGN", agent: { agentId: session.agentId, agentType: "phase-plan:validator" } });
      const { executePhasePlanTool } = await import("../src/mcp/tools.js");
      expect(
        codeOf(() =>
          executePhasePlanTool(w.ctx, "worker_claim", {
            attempt_id: w.attempt.attemptId,
            launch_token: w.launch.launchToken,
            _hostContext: foreignToken,
          }),
        ),
      ).toBe("WORKER_AUTHORITY_REQUIRED");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T52: no E7+ artifacts exist in the source tree (E6-T51)", async () => {
    const w = await makeWorkerWorld();
    try {
      // No production module implements the deferred subsystems (module-name
      // proof; prose mentions inside comments are not implementations).
      const srcRoot = path.resolve(__dirname, "../src");
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.isFile() && entry.name.endsWith(".ts")) {
            // E6 legitimizes the acceptance modules and E7 the progression
            // modules; the E8+ subsystems stay unimplemented (E7-T37).
            expect(path.basename(entry.name), full).not.toMatch(
              /verification-sched|replan-transition|run-completion|execution-observation/i,
            );
          }
        }
      };
      walk(srcRoot);
      const tables = w.ctx.store.withRead((tx) =>
        tx.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all(),
      ).map((row) => (row as { name: string }).name);
      for (const forbidden of ["accepted_head", "execution_observations", "verification_results", "execution_stage_completions", "execution_run_completions"]) {
        expect(tables).not.toContain(forbidden);
      }
      // The claimed attempt is untouched by the scan.
      expect(w.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, w.attempt.attemptId))!.state).toBe("running");
    } finally {
      w.ctx.store.close();
    }
  });
});
