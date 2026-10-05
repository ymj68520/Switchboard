/**
 * SupervisorBinding domain shape (v0.2.0 architecture spec §43, E2 directive §4–§8).
 *
 * PURE core: vocabulary, canonical shape, row validation. No SQLite, no host,
 * no MCP.
 *
 * The SupervisorBinding is the CURRENT writable execution-supervision ownership
 * of one active ExecutionRun — the durable seat the future Supervisor model
 * will occupy (E2 seats the ownership, not the model). It is a separate
 * durable concept from the ExecutionRun:
 *
 *   ExecutionRun.lifecycle   = the execution lifecycle (prepared/active/…)
 *   SupervisorBinding.state  = the supervision attachment (attached/detached)
 *
 * `active` run + `detached` binding is a NORMAL state after session
 * interruption — detachment never mutates ExecutionRun lifecycle.
 *
 * Fencing (E2 §6): ownership uses a monotonically increasing generation.
 * Initial attach = 1; a DIFFERENT-session takeover increments by exactly one;
 * same-session detach/reattach never changes the generation. Any supervision
 * mutation carrying a stale generation fails deterministically. Fencing is
 * authoritative — no liveness/heartbeat/PID signal participates.
 */

import { RuntimeError } from "../runtime/errors.js";

export const SUPERVISOR_BINDING_STATES = ["attached", "detached"] as const;

export type SupervisorBindingState = (typeof SUPERVISOR_BINDING_STATES)[number];

export function isSupervisorBindingState(value: string): value is SupervisorBindingState {
  return (SUPERVISOR_BINDING_STATES as readonly string[]).includes(value);
}

/**
 * SupervisorBinding (E2 §4) — ONE canonical current-owner row per ExecutionRun
 * (persistence enforces the 0..1 writable-owner law, E2 §5). The generation is
 * the supervision fencing epoch; it is Core-owned and never caller-supplied
 * authority (E2 §21).
 */
export interface SupervisorBinding {
  /** The ExecutionRun this binding supervises (execution_runs.execution_run_id). */
  executionRunId: string;
  workspaceId: string;
  /** The current owner session; changes only through explicit takeover. */
  sessionId: string;
  state: SupervisorBindingState;
  /** Supervision fencing epoch — initial attach = 1, takeover +1, never else. */
  generation: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Validate a raw database row into a SupervisorBinding. Illegal state
 * vocabulary, non-positive generation, or broken identity is store corruption
 * — surfaced as STORE_SCHEMA_INVALID, never smuggled into the core.
 */
export function parseSupervisorBindingRow(row: Record<string, unknown>): SupervisorBinding {
  const problems: string[] = [];
  if (typeof row.executionRunId !== "string" || row.executionRunId === "") problems.push("execution_run_id");
  if (typeof row.workspaceId !== "string" || row.workspaceId === "") problems.push("workspace_id");
  if (typeof row.sessionId !== "string" || row.sessionId === "") problems.push("session_id");
  if (typeof row.state !== "string" || !isSupervisorBindingState(row.state)) problems.push("state");
  if (typeof row.generation !== "number" || !Number.isInteger(row.generation) || row.generation < 1) {
    problems.push("generation");
  }
  if (typeof row.createdAt !== "string" || row.createdAt === "") problems.push("created_at");
  if (typeof row.updatedAt !== "string" || row.updatedAt === "") problems.push("updated_at");
  if (problems.length > 0) {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "supervisor_bindings row is corrupt", {
      detail: { fields: problems },
    });
  }
  return {
    executionRunId: row.executionRunId as string,
    workspaceId: row.workspaceId as string,
    sessionId: row.sessionId as string,
    state: row.state as SupervisorBindingState,
    generation: row.generation as number,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}
