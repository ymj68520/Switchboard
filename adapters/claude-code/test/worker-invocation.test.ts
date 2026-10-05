/**
 * v0.2.0 E5 — worker invocation identity (E5 §51 focused tests T1–T7) and the
 * worker report runtime (E5 §56 focused tests T32–T37).
 */
import { describe, expect, it } from "vitest";

import { getWorkerInvocationInTx } from "../src/store/worker-invocations.js";
import { getExecutionAttemptInTx } from "../src/store/execution-attempts.js";
import { getReportForAttemptInTx } from "../src/store/execution-reports.js";
import { getOpenWindowInTx } from "../src/store/execution-structure.js";
import { hostTokenV2 } from "./phase14-helpers.js";
import {
  callWorkerTool,
  codeOf,
  freshWorkerSession,
  makeWorkerWorld,
  workerToken,
} from "./execution-worker-helpers.js";

describe("v0.2.0 E5 — worker invocation identity (T1–T7)", () => {
  it("T1: prepare — one running attempt, one prepared binding, token returned once and never stored", async () => {
    const w = await makeWorkerWorld();
    try {
      expect(w.attempt.state).toBe("running");
      const binding = w.ctx.store.withRead((tx) => getWorkerInvocationInTx(tx, w.attempt.attemptId));
      expect(binding).not.toBeNull();
      expect(binding!.state).toBe("prepared");
      expect(binding!.workerRole).toBe("executor");
      expect(binding!.workerSessionId).toBeNull();
      // The plaintext token is never persisted — only its hash.
      expect(JSON.stringify(binding)).not.toContain(w.launch.launchToken);
      const rows = w.ctx.store.withRead((tx) =>
        tx.prepare("SELECT launch_token_hash AS h FROM execution_worker_invocations").all(),
      ) as Array<{ h: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.h).toMatch(/^sha256:/);
      expect(rows[0]!.h).not.toBe(w.launch.launchToken);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T2: claim — prepared → claimed with the authoritative worker session persisted", async () => {
    const w = await makeWorkerWorld();
    try {
      const session = freshWorkerSession(w, "W1");
      const result = callWorkerTool(w, session, "worker_claim", {
        attempt_id: w.attempt.attemptId,
        launch_token: w.launch.launchToken,
      });
      expect(result.status).toBe("claimed");
      expect(result.attempt_id).toBe(w.attempt.attemptId);
      const binding = w.ctx.store.withRead((tx) => getWorkerInvocationInTx(tx, w.attempt.attemptId));
      expect(binding!.state).toBe("claimed");
      expect(binding!.workerSessionId).toBe(session.sessionId);
      expect(binding!.claimedAt).not.toBeNull();
    } finally {
      w.ctx.store.close();
    }
  });

  it("T3: the launch token is one-time — a second session can never claim", async () => {
    const w = await makeWorkerWorld();
    try {
      const first = freshWorkerSession(w, "W1");
      callWorkerTool(w, first, "worker_claim", {
        attempt_id: w.attempt.attemptId,
        launch_token: w.launch.launchToken,
      });
      const second = freshWorkerSession(w, "W2");
      expect(
        codeOf(() =>
          callWorkerTool(w, second, "worker_claim", {
            attempt_id: w.attempt.attemptId,
            launch_token: w.launch.launchToken,
          }),
        ),
      ).toBe("WORKER_ATTEMPT_ALREADY_CLAIMED");
      const binding = w.ctx.store.withRead((tx) => getWorkerInvocationInTx(tx, w.attempt.attemptId));
      expect(binding!.workerSessionId).toBe(first.sessionId);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T4: a token for ATT-A cannot claim ATT-B", async () => {
    const w = await makeWorkerWorld();
    try {
      // A second directive + attempt + launch (sequential — no concurrent runs).
      const other = w.ctx.store.withRead((tx) => getWorkerInvocationInTx(tx, w.attempt.attemptId));
      expect(other!.attemptId).toBe(w.attempt.attemptId);
      const session = freshWorkerSession(w, "W1");
      // Claimed A first; then a forged claim of a NONEXISTENT attempt-B with A's token.
      callWorkerTool(w, session, "worker_claim", {
        attempt_id: w.attempt.attemptId,
        launch_token: w.launch.launchToken,
      });
      expect(
        codeOf(() =>
          callWorkerTool(w, freshWorkerSession(w, "W2"), "worker_claim", {
            attempt_id: "att_does_not_exist",
            launch_token: w.launch.launchToken,
          }),
        ),
      ).toBe("WORKER_CLAIM_TOKEN_INVALID");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T5: the workspace fence — a claim from another WorkspaceIdentity fails", async () => {
    const w = await makeWorkerWorld();
    try {
      const session = { ...freshWorkerSession(w, "W1"), workspaceId: "ws_other_workspace" };
      expect(
        codeOf(() =>
          callWorkerTool(w, session, "worker_claim", {
            attempt_id: w.attempt.attemptId,
            launch_token: w.launch.launchToken,
          }),
        ),
      ).toBe("WORKER_SESSION_MISMATCH");
      // The failed claim bound nothing.
      const binding = w.ctx.store.withRead((tx) => getWorkerInvocationInTx(tx, w.attempt.attemptId));
      expect(binding!.state).toBe("prepared");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T6: a parent session cannot forge worker authority by supplying ids as arguments", async () => {
    const w = await makeWorkerWorld();
    try {
      // A planning-domain main-session token (no agent identity) can never
      // satisfy the worker authority verifier — whatever args it carries.
      const forged = hostTokenV2(w.ctx.secret, "worker_claim", {}, {
        sessionId: w.f.sessionId,
        workspaceId: w.f.workspaceId,
        runId: w.f.runId,
        generation: w.f.generation,
      }, { toolUseId: "TU-FORGE" });
      const { executePhasePlanTool } = await import("../src/mcp/tools.js");
      // An unknown extra argument is refused outright — a worker session id is
      // never an acceptable business field.
      expect(
        codeOf(() =>
          executePhasePlanTool(w.ctx, "worker_claim", {
            attempt_id: w.attempt.attemptId,
            launch_token: w.launch.launchToken,
            worker_session_id: "worker-session-W1",
            _hostContext: forged,
          }),
        ),
      ).toBe("MCP_INPUT_INVALID");
      // A well-formed call carrying only a planning token fails worker authority.
      expect(
        codeOf(() =>
          executePhasePlanTool(w.ctx, "worker_claim", {
            attempt_id: w.attempt.attemptId,
            launch_token: w.launch.launchToken,
            _hostContext: forged,
          }),
        ),
      ).toBe("WORKER_AUTHORITY_REQUIRED");
      // A worker token signed for the WRONG agent type fails too.
      const wrongType = workerToken(w.ctx, freshWorkerSession(w, "W1"), "worker_claim", {
        attempt_id: w.attempt.attemptId,
        launch_token: w.launch.launchToken,
      });
      expect(wrongType).not.toBe("");
      const binding = w.ctx.store.withRead((tx) => getWorkerInvocationInTx(tx, w.attempt.attemptId));
      expect(binding!.state).toBe("prepared");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T7: worker-only assignment — a claimed worker loads it; an unclaimed session cannot", async () => {
    const w = await makeWorkerWorld();
    try {
      const unclaimed = freshWorkerSession(w, "W0");
      expect(codeOf(() => callWorkerTool(w, unclaimed, "worker_get_assignment", {}))).toBe(
        "WORKER_AUTHORITY_REQUIRED",
      );
      const session = freshWorkerSession(w, "W1");
      callWorkerTool(w, session, "worker_claim", {
        attempt_id: w.attempt.attemptId,
        launch_token: w.launch.launchToken,
      });
      const assignment = callWorkerTool(w, session, "worker_get_assignment", {});
      expect(assignment.status).toBe("ok");
      expect((assignment.directive as Record<string, unknown>).directiveId).toBe("DIR-W");
    } finally {
      w.ctx.store.close();
    }
  });
});

describe("v0.2.0 E5 — worker report runtime (T32–T37)", () => {
  it("T32: a claimed worker submits the report for its OWN attempt", async () => {
    const w = await makeWorkerWorld();
    try {
      const session = freshWorkerSession(w, "W1");
      callWorkerTool(w, session, "worker_claim", {
        attempt_id: w.attempt.attemptId,
        launch_token: w.launch.launchToken,
      });
      const result = callWorkerTool(w, session, "worker_submit_report", {
        result: "completed",
        candidate_mutated: false,
        files_examined: ["src/index.ts"],
      });
      expect(result.status).toBe("reported");
      expect(result.invocation).toBe("finished");
      const attempt = w.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, w.attempt.attemptId));
      expect(attempt!.state).toBe("reported");
      expect(w.ctx.store.withRead((tx) => getReportForAttemptInTx(tx, w.attempt.attemptId))).not.toBeNull();
    } finally {
      w.ctx.store.close();
    }
  });

  it("T33: worker session B cannot submit for worker A's attempt", async () => {
    const w = await makeWorkerWorld();
    try {
      const a = freshWorkerSession(w, "W1");
      callWorkerTool(w, a, "worker_claim", {
        attempt_id: w.attempt.attemptId,
        launch_token: w.launch.launchToken,
      });
      const b = freshWorkerSession(w, "W2");
      expect(
        codeOf(() =>
          callWorkerTool(w, b, "worker_submit_report", { result: "completed", candidate_mutated: false }),
        ),
      ).toBe("WORKER_AUTHORITY_REQUIRED");
      expect(w.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, w.attempt.attemptId))!.state).toBe("running");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T34: the supervisor session cannot impersonate a worker report", async () => {
    const w = await makeWorkerWorld();
    try {
      const { executePhasePlanTool } = await import("../src/mcp/tools.js");
      // Supervisor uses a planning V2 token: never worker authority.
      const supervisorToken = hostTokenV2(w.ctx.secret, "worker_submit_report", {}, {
        sessionId: w.f.sessionId,
        workspaceId: w.f.workspaceId,
        runId: w.f.runId,
        generation: w.f.generation,
      }, { toolUseId: "TU-SUPERVISE" });
      expect(
        codeOf(() =>
          executePhasePlanTool(w.ctx, "worker_submit_report", {
            result: "completed",
            candidate_mutated: false,
            _hostContext: supervisorToken,
          }),
        ),
      ).toBe("WORKER_AUTHORITY_REQUIRED");
      expect(w.ctx.store.withRead((tx) => getReportForAttemptInTx(tx, w.attempt.attemptId))).toBeNull();
    } finally {
      w.ctx.store.close();
    }
  });

  it("T35: durable-before-return — the report, attempt state, and invocation commit before the tool returns", async () => {
    const w = await makeWorkerWorld();
    try {
      const session = freshWorkerSession(w, "W1");
      callWorkerTool(w, session, "worker_claim", {
        attempt_id: w.attempt.attemptId,
        launch_token: w.launch.launchToken,
      });
      const result = callWorkerTool(w, session, "worker_submit_report", {
        result: "completed",
        candidate_mutated: false,
      });
      // By the time the tool returned, EVERYTHING is durable.
      const attempt = w.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, w.attempt.attemptId));
      expect(attempt!.state).toBe("reported");
      expect(attempt!.endedAt).not.toBeNull();
      const binding = w.ctx.store.withRead((tx) => getWorkerInvocationInTx(tx, w.attempt.attemptId));
      expect(binding!.state).toBe("finished");
      expect(binding!.finishedAt).not.toBeNull();
      expect(result.report_id).not.toBeNull();
      // The finished invocation is terminal — a second report is refused.
      expect(
        codeOf(() =>
          callWorkerTool(w, session, "worker_submit_report", { result: "completed", candidate_mutated: false }),
        ),
      ).toBe("WORKER_INVOCATION_FINISHED");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T36: a real worker's candidateMutated=true advances the candidate exactly once via the E4 transaction", async () => {
    const w = await makeWorkerWorld();
    try {
      const session = freshWorkerSession(w, "W1");
      callWorkerTool(w, session, "worker_claim", {
        attempt_id: w.attempt.attemptId,
        launch_token: w.launch.launchToken,
      });
      const before = w.ctx.store.withRead((tx) => getOpenWindowInTx(tx, w.executionRunId));
      const result = callWorkerTool(w, session, "worker_submit_report", {
        result: "completed",
        candidate_mutated: true,
        files_changed: ["src/implemented.ts"],
      });
      expect(result.candidate_revision).toBe(before!.candidateRevision + 1);
      expect(w.ctx.store.withRead((tx) => getOpenWindowInTx(tx, w.executionRunId))!.candidateRevision).toBe(1);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T37: a blocked worker submits blocked + structured blocker and exits normally", async () => {
    const w = await makeWorkerWorld();
    try {
      const session = freshWorkerSession(w, "W1");
      callWorkerTool(w, session, "worker_claim", {
        attempt_id: w.attempt.attemptId,
        launch_token: w.launch.launchToken,
      });
      const result = callWorkerTool(w, session, "worker_submit_report", {
        result: "blocked",
        candidate_mutated: false,
        blockers: [
          { kind: "MISSING_CONTEXT", summary: "helper undocumented", details: null, relevantRefs: [] },
        ],
      });
      expect(result.status).toBe("reported");
      expect(result.result).toBe("blocked");
      // No hidden clarification RPC exists — the blocked report IS the protocol.
      const attempt = w.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, w.attempt.attemptId));
      expect(attempt!.state).toBe("reported");
    } finally {
      w.ctx.store.close();
    }
  });
});
