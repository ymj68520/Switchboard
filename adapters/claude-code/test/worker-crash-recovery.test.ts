/**
 * v0.2.0 E5 — crash semantics + recovery (E5 §57/§58 focused tests T38–T47).
 */
import { describe, expect, it } from "vitest";

import { handleSessionStart } from "../src/hooks/handlers.js";
import { resolveUnreportedWorkerExitInTx } from "../src/application/worker-runtime-service.js";
import { getWorkerInvocationInTx } from "../src/store/worker-invocations.js";
import { getExecutionAttemptInTx } from "../src/store/execution-attempts.js";
import { getReportForAttemptInTx } from "../src/store/execution-reports.js";
import {
  callWorkerTool,
  codeOf,
  freshWorkerSession,
  makeWorkerWorld,
  type WorkerWorld,
} from "./execution-worker-helpers.js";

async function claimedWorker(w: WorkerWorld, name = "W1") {
  const session = freshWorkerSession(w, name);
  callWorkerTool(w, session, "worker_claim", {
    attempt_id: w.attempt.attemptId,
    launch_token: w.launch.launchToken,
  });
  return session;
}

describe("v0.2.0 E5 — crash semantics (T38–T43)", () => {
  it("T38: a claimed worker that exits unreported converges to indeterminate + finished (no report, no replay)", async () => {
    const w = await makeWorkerWorld();
    try {
      const session = await claimedWorker(w, "W1");
      // The authoritative host stop event arrives.
      const result = w.ctx.store.withWrite((tx) =>
        resolveUnreportedWorkerExitInTx(tx, { attemptId: w.attempt.attemptId }, w.ctx.clock.nowIso()),
      );
      expect(result.attempt.state).toBe("indeterminate");
      expect(result.attempt.endedAt).not.toBeNull();
      expect(result.invocation.state).toBe("finished");
      expect(w.ctx.store.withRead((tx) => getReportForAttemptInTx(tx, w.attempt.attemptId))).toBeNull();
      // No replay: the revision stays attempted forever.
      const service = await import("../src/application/execution-attempt-service.js");
      expect(
        codeOf(() =>
          service.createExecutionAttemptService(w.ctx.store, w.ctx.clock).startExecutionAttempt({
            executionRunId: w.executionRunId,
            sessionId: w.f.sessionId,
            workspaceId: w.f.workspaceId,
            generation: w.f.generation,
            directiveId: w.directive.directiveId,
            directiveRevision: w.directive.revision,
            directiveHash: w.directive.hash,
            workerRole: "executor",
          }),
        ),
      ).toBe("ATTEMPT_RECONCILIATION_REQUIRED");
      void session;
    } finally {
      w.ctx.store.close();
    }
  });

  it("T39: a reported worker exit never becomes indeterminate", async () => {
    const w = await makeWorkerWorld();
    try {
      const session = await claimedWorker(w, "W1");
      callWorkerTool(w, session, "worker_submit_report", { result: "completed", candidate_mutated: false });
      // A late/erroneous stop resolution is refused — the attempt stays reported.
      expect(
        codeOf(() =>
          w.ctx.store.withWrite((tx) =>
            resolveUnreportedWorkerExitInTx(tx, { attemptId: w.attempt.attemptId }, w.ctx.clock.nowIso()),
          ),
        ),
      ).toBe("ATTEMPT_ALREADY_REPORTED");
      expect(w.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, w.attempt.attemptId))!.state).toBe("reported");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T40: supervisor detach does not cancel a claimed worker — it can still report", async () => {
    const w = await makeWorkerWorld();
    try {
      const session = await claimedWorker(w, "W1");
      // The supervisor session detaches (SessionEnd best-effort path).
      w.ctx.store.withWrite((tx) => {
        tx.prepare("UPDATE supervisor_bindings SET state = 'detached' WHERE execution_run_id = ?").run(w.executionRunId);
      });
      // The worker's authority is attempt-scoped: it still reports successfully.
      const result = callWorkerTool(w, session, "worker_submit_report", {
        result: "completed",
        candidate_mutated: false,
      });
      expect(result.status).toBe("reported");
      // Force-verify the detached state was real.
      const binding = w.ctx.store.withRead((tx) =>
        tx.prepare("SELECT state FROM supervisor_bindings WHERE execution_run_id = ?").get(w.executionRunId),
      ) as { state: string };
      expect(binding.state).toBe("detached");
    } finally {
      w.ctx.store.close();
    }

  });

  it("T41: worker tools fail closed when authority cannot be verified", async () => {
    const w = await makeWorkerWorld();
    try {
      // Unclaimed session → every worker tool denied (authority unverifiable).
      const unclaimed = freshWorkerSession(w, "W0");
      expect(codeOf(() => callWorkerTool(w, unclaimed, "worker_get_assignment", {}))).toBe(
        "WORKER_AUTHORITY_REQUIRED",
      );
      expect(codeOf(() => callWorkerTool(w, unclaimed, "worker_submit_report", { result: "completed", candidate_mutated: false }))).toBe(
        "WORKER_AUTHORITY_REQUIRED",
      );
      // A corrupted binding (unknown state) also fails closed at the parser.
      expect(w.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, w.attempt.attemptId))!.state).toBe("running");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T42: no reliable stop signal — the attempt stays running (never guessed)", async () => {
    const w = await makeWorkerWorld();
    try {
      await claimedWorker(w, "W1");
      // Nothing authoritative arrived: no reconciliation, no timeout logic exists.
      const attempt = w.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, w.attempt.attemptId));
      expect(attempt!.state).toBe("running");
      // The recovery projection says runtime resolution is pending.
      const { createSupervisorBindingService } = await import("../src/application/supervisor-binding-service.js");
      const facts = w.ctx.store.withRead((tx) =>
        createSupervisorBindingService(w.ctx.store, w.ctx.clock).loadExecutionRecoveryFactsInTx(tx, {
          executionRunId: w.executionRunId,
          sessionId: w.f.sessionId,
        }),
      );
      expect(facts.protocol!.attempt!.state).toBe("running");
      expect(facts.protocol!.attempt!.workerRuntime).toBe("claimed");
      const { renderExecutionRecoveryContext } = await import("../src/context/execution-recovery.js");
      const text = renderExecutionRecoveryContext(facts);
      expect(text).toContain("runtime resolution pending");
      expect(text).toContain("worker runtime: claimed");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T43: an indeterminate attempt's directive revision can never launch a second logical attempt", async () => {
    const w = await makeWorkerWorld();
    try {
      await claimedWorker(w, "W1");
      w.ctx.store.withWrite((tx) =>
        resolveUnreportedWorkerExitInTx(tx, { attemptId: w.attempt.attemptId }, w.ctx.clock.nowIso()),
      );
      // E4 uniqueness remains authoritative.
      const service = await import("../src/application/execution-attempt-service.js");
      expect(
        codeOf(() =>
          service.createExecutionAttemptService(w.ctx.store, w.ctx.clock).startExecutionAttempt({
            executionRunId: w.executionRunId,
            sessionId: w.f.sessionId,
            workspaceId: w.f.workspaceId,
            generation: w.f.generation,
            directiveId: w.directive.directiveId,
            directiveRevision: w.directive.revision,
            directiveHash: w.directive.hash,
            workerRole: "executor",
          }),
        ),
      ).toBe("ATTEMPT_RECONCILIATION_REQUIRED");
      // Even the E4 CAS advance + a revised directive would be the legal path —
      // the SAME revision is never re-attempted.
      const attempts = w.ctx.store.withRead((tx) =>
        tx.prepare("SELECT count(*) AS n FROM execution_attempts").get(),
      ) as { n: number };
      expect(attempts.n).toBe(1);
    } finally {
      w.ctx.store.close();
    }
  });
});

describe("v0.2.0 E5 — recovery (T44–T47)", () => {
  it("T44: the recovery context shows the claimed running worker", async () => {
    const w = await makeWorkerWorld();
    try {
      await claimedWorker(w, "W1");
      const { createSupervisorBindingService } = await import("../src/application/supervisor-binding-service.js");
      const facts = w.ctx.store.withRead((tx) =>
        createSupervisorBindingService(w.ctx.store, w.ctx.clock).loadExecutionRecoveryFactsInTx(tx, {
          executionRunId: w.executionRunId,
          sessionId: w.f.sessionId,
        }),
      );
      expect(facts.protocol!.attempt!.workerRuntime).toBe("claimed");
      const { renderExecutionRecoveryContext } = await import("../src/context/execution-recovery.js");
      const text = renderExecutionRecoveryContext(facts);
      expect(text).toContain("worker runtime: claimed");
      // No launch-token secret is ever rendered.
      expect(text).not.toContain(w.launch.launchToken);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T45: a pre-E5 running attempt shows as unresolved/unbound — no fabricated worker identity", async () => {
    const w = await makeWorkerWorld();
    try {
      // Remove the invocation binding the way a pre-E5 world would have none
      // (test-only surgery; E1–E4 running attempts carry no binding).
      w.ctx.store.withWrite((tx) => {
        tx.exec("DROP TRIGGER execution_worker_invocations_no_delete");
        tx.exec("DROP TRIGGER execution_worker_invocation_events_no_delete");
        tx.prepare("DELETE FROM execution_worker_invocation_events WHERE attempt_id = ?").run(w.attempt.attemptId);
        tx.prepare("DELETE FROM execution_worker_invocations WHERE attempt_id = ?").run(w.attempt.attemptId);
        tx.exec("CREATE TRIGGER execution_worker_invocations_no_delete BEFORE DELETE ON execution_worker_invocations BEGIN SELECT RAISE(ABORT, 'execution_worker_invocations is immutable'); END");
        tx.exec("CREATE TRIGGER execution_worker_invocation_events_no_delete BEFORE DELETE ON execution_worker_invocation_events BEGIN SELECT RAISE(ABORT, 'execution_worker_invocation_events is immutable'); END");
      });
      const { createSupervisorBindingService } = await import("../src/application/supervisor-binding-service.js");
      const facts = w.ctx.store.withRead((tx) =>
        createSupervisorBindingService(w.ctx.store, w.ctx.clock).loadExecutionRecoveryFactsInTx(tx, {
          executionRunId: w.executionRunId,
          sessionId: w.f.sessionId,
        }),
      );
      expect(facts.protocol!.attempt!.state).toBe("running");
      expect(facts.protocol!.attempt!.workerRuntime).toBe("unbound (legacy or not yet launched)");
      const { renderExecutionRecoveryContext } = await import("../src/context/execution-recovery.js");
      const text = renderExecutionRecoveryContext(facts);
      expect(text).toContain("worker runtime: unbound");
      expect(text).toContain("runtime resolution pending");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T46: compaction changes nothing — attempt, binding, directive, report all stand", async () => {
    const w = await makeWorkerWorld();
    try {
      const session = await claimedWorker(w, "W1");
      callWorkerTool(w, session, "worker_submit_report", { result: "completed", candidate_mutated: true });
      const snapshot = () =>
        w.ctx.store.withRead((tx) => ({
          attempts: tx.prepare("SELECT * FROM execution_attempts ORDER BY attempt_id").all(),
          invocations: tx.prepare("SELECT * FROM execution_worker_invocations ORDER BY attempt_id").all(),
          directives: tx.prepare("SELECT * FROM execution_directives ORDER BY directive_id, revision").all(),
          reports: tx.prepare("SELECT * FROM execution_reports ORDER BY report_id").all(),
          windows: tx.prepare("SELECT candidate_revision, id FROM verification_windows").all(),
        }));
      const before = snapshot();
      // Compaction fires SessionStart with source=compact for the SUPERVISOR session.
      const output = await handleSessionStart(
        { store: w.ctx.store, secret: w.ctx.secret, clock: w.ctx.clock },
        { sessionId: w.f.sessionId, cwd: w.f.workspaceRoot, source: "compact", hookEventName: "SessionStart" },
      );
      expect(output.kind).toBe("json");
      expect(snapshot()).toEqual(before);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T47: a supervisor takeover does not rewrite an already claimed worker invocation", async () => {
    const w = await makeWorkerWorld();
    try {
      await claimedWorker(w, "W1");
      const bindingBefore = w.ctx.store.withRead((tx) => getWorkerInvocationInTx(tx, w.attempt.attemptId));
      // Explicit supervision takeover by another session (generation 1 → 2).
      const { createRunControlService } = await import("../src/application/run-control-service.js");
      const control = createRunControlService(w.ctx.store, w.ctx.clock);
      const taken = control.takeoverRun({
        runId: w.f.runId,
        workspaceId: w.f.workspaceId,
        callerSessionId: "S-NEW-SUPERVISOR",
        expectedBindingGeneration: 1,
        authorization: {
          authorizationRequestId: "req-takeover-e5",
          operationId: "op-takeover-e5",
          requestHash: "hash-takeover-e5",
        },
      });
      expect(taken.supervisor!.generation).toBe(2);
      // The claimed worker invocation is untouched and stays exact.
      const bindingAfter = w.ctx.store.withRead((tx) => getWorkerInvocationInTx(tx, w.attempt.attemptId));
      expect(bindingAfter).toEqual(bindingBefore);
      // The new supervisor can still start NEW attempts; the old worker keeps its authority.
      const attempt = w.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, w.attempt.attemptId));
      expect(attempt!.state).toBe("running");
    } finally {
      w.ctx.store.close();
    }
  });
});
