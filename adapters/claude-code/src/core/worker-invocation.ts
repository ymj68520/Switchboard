/**
 * WorkerInvocationBinding domain shape (v0.2.0 E5 §8/§46/§47).
 *
 * PURE core: vocabulary, canonical shape, row validation, frozen transition
 * authority. No SQLite, no host, no MCP.
 *
 * A WorkerInvocationBinding is RUNTIME/ADAPTER authority metadata — it proves
 * that ONE Claude subagent session is the authorized Worker for ONE exact
 * Attempt. It is NOT accepted execution progress, NOT an ExecutionCommit, and
 * NOT a SupervisorBinding. Attempt remains the logical work state
 * (running/reported/indeterminate); the invocation state
 * (prepared/claimed/finished) is only host runtime correlation (E5 §47).
 *
 * Frozen lifecycle:
 *
 *   ABSENT   → prepared   (launch package created; one-time token hashed)
 *   prepared → claimed    (a fresh worker session consumed the launch token)
 *   claimed  → finished   (the report is durably persisted / stop resolved)
 *
 * prepared/claimed are terminal in the sense that they never rewind; a
 * finished invocation can never return to claimed/prepared (E5 §46). The
 * claimed worker session is set AT MOST ONCE and never rewritten (E5 §46).
 */

import { RuntimeError } from "../runtime/errors.js";

export const WORKER_INVOCATION_STATES = ["prepared", "claimed", "finished"] as const;

export type WorkerInvocationState = (typeof WORKER_INVOCATION_STATES)[number];

export function isWorkerInvocationState(value: string): value is WorkerInvocationState {
  return (WORKER_INVOCATION_STATES as readonly string[]).includes(value);
}

export interface WorkerInvocationBinding {
  /** The exact Attempt this invocation is authorized to execute. */
  attemptId: string;
  executionRunId: string;
  workerRole: "executor" | "verifier";
  state: WorkerInvocationState;
  /** The authoritative worker session — set at most once, at claim time. */
  workerSessionId: string | null;
  /** The host's opaque per-spawn agent id (pre-claim retry correlation). */
  workerAgentId: string | null;
  /** sha256 of the one-time launch token — plaintext is never persisted. */
  launchTokenHash: string;
  createdAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
}

/** Validate a raw database row into a WorkerInvocationBinding. */
export function parseWorkerInvocationRow(row: Record<string, unknown>): WorkerInvocationBinding {
  const problems: string[] = [];
  if (typeof row.attemptId !== "string" || row.attemptId === "") problems.push("attempt_id");
  if (typeof row.executionRunId !== "string" || row.executionRunId === "") problems.push("execution_run_id");
  if (typeof row.workerRole !== "string" || (row.workerRole !== "executor" && row.workerRole !== "verifier")) {
    problems.push("worker_role");
  }
  if (typeof row.state !== "string" || !isWorkerInvocationState(row.state)) problems.push("state");
  if (row.workerSessionId !== null && typeof row.workerSessionId !== "string") problems.push("worker_session_id");
  if (row.workerAgentId !== null && typeof row.workerAgentId !== "string") problems.push("worker_agent_id");
  if (typeof row.launchTokenHash !== "string" || row.launchTokenHash === "") problems.push("launch_token_hash");
  if (typeof row.createdAt !== "string" || row.createdAt === "") problems.push("created_at");
  if (row.claimedAt !== null && typeof row.claimedAt !== "string") problems.push("claimed_at");
  if (row.finishedAt !== null && typeof row.finishedAt !== "string") problems.push("finished_at");
  if (problems.length > 0) {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "execution_worker_invocations row is corrupt", {
      detail: { fields: problems },
    });
  }
  return {
    attemptId: row.attemptId as string,
    executionRunId: row.executionRunId as string,
    workerRole: row.workerRole as WorkerInvocationBinding["workerRole"],
    state: row.state as WorkerInvocationState,
    workerSessionId: row.workerSessionId as string | null,
    workerAgentId: row.workerAgentId as string | null,
    launchTokenHash: row.launchTokenHash as string,
    createdAt: row.createdAt as string,
    claimedAt: row.claimedAt as string | null,
    finishedAt: row.finishedAt as string | null,
  };
}

/**
 * The frozen E5 invocation transition authority (E5 §46). Legal set exactly:
 * ABSENT → prepared, prepared → claimed, claimed → finished. Every other pair
 * — including finished rewinds and claimed → prepared — is
 * INVALID_WORKER_INVOCATION_TRANSITION.
 */
export function requireLegalWorkerInvocationTransition(
  from: WorkerInvocationState | null,
  to: WorkerInvocationState,
): void {
  const legal =
    (from === null && to === "prepared") || (from === "prepared" && to === "claimed") || (from === "claimed" && to === "finished");
  if (!legal) {
    throw new RuntimeError(
      "INVALID_WORKER_INVOCATION_TRANSITION",
      `WorkerInvocation state transition ${from ?? "ABSENT"} → ${to} is not authorized`,
      { detail: { from: from ?? "ABSENT", to }, recoverable: false },
    );
  }
}
