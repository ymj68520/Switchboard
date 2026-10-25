/**
 * Worker Process Coordinator & Recovery Capability Boundary (Phase Plan v0.2.0 P5).
 *
 * Implements:
 * 1. Tiered worker timeout management:
 *    - startup timeout: time between prepared launch and worker claim.
 *    - no-progress timeout: max time without heartbeat / progress output during execution.
 *    - absolute timeout: upper bound on total execution runtime.
 * 2. Process lifecycle & termination fence:
 *    - Ensures child processes are verified terminated before marking an attempt indeterminate.
 *    - Fails closed if child processes are still running to prevent concurrent side effects.
 * 3. Machine-readable recovery guidance for Supervisor.
 */

import { RuntimeError } from "../runtime/errors.js";
import type { StoreTx } from "../store/transaction.js";
import { getExecutionDirectiveInTx } from "../store/execution-directives.js";
import { getOpenWindowInTx } from "../store/execution-structure.js";
import {
  listUnresolvedIndeterminateInTx,
} from "./recovery-fence.js";
import { isSideEffectCapable } from "../core/attempt-reconciliation.js";
import { resolveUnreportedWorkerExitInTx } from "./worker-runtime-service.js";

export interface WorkerTimeoutConfig {
  startupTimeoutMs: number;    // default: 30_000 (30s)
  noProgressTimeoutMs: number; // default: 60_000 (60s)
  absoluteTimeoutMs: number;   // default: 300_000 (5m)
}

export const DEFAULT_WORKER_TIMEOUT_CONFIG: WorkerTimeoutConfig = {
  startupTimeoutMs: 30_000,
  noProgressTimeoutMs: 60_000,
  absoluteTimeoutMs: 300_000,
};

export interface WorkerProgressRecord {
  attemptId: string;
  startedAtMs: number;
  lastProgressAtMs: number;
  lastProgressDetail: string;
  processId: number | null;
}

// In-memory process and heartbeat registry for active worker subprocesses
const activeProcessRegistry = new Map<string, WorkerProgressRecord>();

/**
 * Register a launched worker attempt with its process ID and initial timestamp.
 */
export function registerWorkerProcess(attemptId: string, processId: number | null = null, nowMs: number = Date.now()): void {
  activeProcessRegistry.set(attemptId, {
    attemptId,
    startedAtMs: nowMs,
    lastProgressAtMs: nowMs,
    lastProgressDetail: "Worker attempt initialized",
    processId,
  });
}

/**
 * Record progress from a long-running worker (e.g. streaming build output or test progress).
 */
export function recordWorkerProgress(attemptId: string, detail: string, nowMs: number = Date.now()): void {
  const existing = activeProcessRegistry.get(attemptId);
  if (existing) {
    existing.lastProgressAtMs = nowMs;
    existing.lastProgressDetail = detail;
  } else {
    activeProcessRegistry.set(attemptId, {
      attemptId,
      startedAtMs: nowMs,
      lastProgressAtMs: nowMs,
      lastProgressDetail: detail,
      processId: null,
    });
  }
}

export type WorkerLivenessStatus =
  | "healthy"
  | "startup_timeout"
  | "no_progress_timeout"
  | "absolute_timeout";

/**
 * Evaluate worker attempt liveness against tiered timeout configuration.
 */
export function evaluateWorkerLiveness(
  attemptId: string,
  claimed: boolean,
  config: WorkerTimeoutConfig = DEFAULT_WORKER_TIMEOUT_CONFIG,
  nowMs: number = Date.now(),
): { status: WorkerLivenessStatus; reason?: string } {
  const record = activeProcessRegistry.get(attemptId);
  const startedAt = record?.startedAtMs ?? nowMs;
  const lastProgressAt = record?.lastProgressAtMs ?? startedAt;

  // 1. Startup timeout: prepared but not claimed within limit
  if (!claimed && nowMs - startedAt > config.startupTimeoutMs) {
    return {
      status: "startup_timeout",
      reason: `Worker did not claim launch ticket within ${config.startupTimeoutMs}ms startup timeout`,
    };
  }

  // 2. Absolute timeout: total execution time exceeded
  if (nowMs - startedAt > config.absoluteTimeoutMs) {
    return {
      status: "absolute_timeout",
      reason: `Worker exceeded absolute runtime limit of ${config.absoluteTimeoutMs}ms`,
    };
  }

  // 3. No-progress timeout: claimed worker produced no heartbeat/progress
  if (claimed && nowMs - lastProgressAt > config.noProgressTimeoutMs) {
    return {
      status: "no_progress_timeout",
      reason: `Worker produced no progress output for ${config.noProgressTimeoutMs}ms (last: '${record?.lastProgressDetail ?? "none"}')`,
    };
  }

  return { status: "healthy" };
}

/**
 * Verify whether a subprocess is alive and terminate it safely if requested.
 */
export function ensureSubprocessTerminated(
  processId: number | null,
  forceTerminate = true,
): { terminated: boolean; pid: number | null } {
  if (processId === null) {
    return { terminated: true, pid: null };
  }

  try {
    // Check process existence with signal 0
    process.kill(processId, 0);
    // Process is still alive
    if (forceTerminate) {
      try {
        process.kill(processId, "SIGTERM");
      } catch {
        // ignore
      }
      return { terminated: false, pid: processId };
    }
    return { terminated: false, pid: processId };
  } catch (err: unknown) {
    // ESRCH means process does not exist (already dead)
    if ((err as { code?: string })?.code === "ESRCH") {
      return { terminated: true, pid: processId };
    }
    return { terminated: false, pid: processId };
  }
}

/**
 * Transition an interrupted attempt to indeterminate safely, verifying
 * that any associated subprocess is terminated first (P5 §3).
 */
export function terminateAndMarkIndeterminateInTx(
  tx: StoreTx,
  input: {
    attemptId: string;
    overrideProcessAliveCheck?: boolean;
  },
  now: string,
): ReturnType<typeof resolveUnreportedWorkerExitInTx> {
  const record = activeProcessRegistry.get(input.attemptId);
  if (record?.processId && !input.overrideProcessAliveCheck) {
    const check = ensureSubprocessTerminated(record.processId, false);
    if (!check.terminated) {
      throw new RuntimeError(
        "WORKER_PROCESS_STILL_ALIVE",
        `subprocess PID ${record.processId} for attempt '${input.attemptId}' is still running; `
          + "cannot release fence or mark indeterminate while side-effecting processes are active (P5 §3)",
        { detail: { attemptId: input.attemptId, pid: record.processId }, recoverable: false },
      );
    }
  }

  activeProcessRegistry.delete(input.attemptId);
  return resolveUnreportedWorkerExitInTx(tx, { attemptId: input.attemptId }, now);
}

export interface DetailedRecoveryGuidance {
  fenced: boolean;
  unresolvedAttemptId: string | null;
  sideEffectCapable: boolean;
  directiveId: string | null;
  directiveRevision: number | null;
  recommendedActions: Array<{
    action: string;
    tool: string;
    description: string;
  }>;
}

/**
 * Build complete machine-readable recovery guidance for the Supervisor.
 */
export function getDetailedRecoveryGuidanceInTx(
  tx: StoreTx,
  executionRunId: string,
): DetailedRecoveryGuidance {
  const openWindow = getOpenWindowInTx(tx, executionRunId);
  const unresolved = openWindow
    ? listUnresolvedIndeterminateInTx(tx, executionRunId, { windowId: openWindow.id })
    : [];

  if (unresolved.length === 0) {
    return {
      fenced: false,
      unresolvedAttemptId: null,
      sideEffectCapable: false,
      directiveId: null,
      directiveRevision: null,
      recommendedActions: [],
    };
  }

  const target = unresolved[0]!;
  const directive = getExecutionDirectiveInTx(tx, target.directiveId, target.directiveRevision);
  const sideEffectCapable = directive ? isSideEffectCapable(directive.capabilityEnvelope) : true;

  const recommendedActions: Array<{ action: string; tool: string; description: string }> = [];

  if (!sideEffectCapable) {
    recommendedActions.push({
      action: "fast_reconcile_no_effect",
      tool: "resolve_indeterminate_attempt",
      description: "Directive was non-mutating: resolve indeterminate attempt directly with resolution='no_effect_by_capability'",
    });
  } else {
    recommendedActions.push({
      action: "issue_inspection",
      tool: "issue_attempt_reconciliation",
      description: "Issue a read-only inspection directive to determine whether workspace candidate was mutated",
    });
    recommendedActions.push({
      action: "settle_reconciliation",
      tool: "resolve_indeterminate_attempt",
      description: "After inspection report completes, call resolve_indeterminate_attempt with inspection_report_id",
    });
  }

  recommendedActions.push({
    action: "abort_or_replan",
    tool: "request_execution_replan",
    description: "If candidate reality cannot be reconciled safely, trigger replan to start a new planning baseline",
  });

  return {
    fenced: true,
    unresolvedAttemptId: target.attemptId,
    sideEffectCapable,
    directiveId: target.directiveId,
    directiveRevision: target.directiveRevision,
    recommendedActions,
  };
}
