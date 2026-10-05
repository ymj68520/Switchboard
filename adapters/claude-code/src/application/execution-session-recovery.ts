/**
 * ExecutionSessionStart classification (v0.2.0 E12 §4–§13/§23–§29/§50–§52;
 * E12 Closure Amendment §4–§13 — conversation-operation identity never
 * collapses into ClaudeSessionID identity when the Host authoritatively
 * proves a clear/fork boundary).
 *
 * ONE deterministic classifier over canonical Store identity: the outcome is
 * derived from ClaudeSessionID + WorkspaceIdentity + SupervisorBinding state
 * and NEVER from conversation text, transcript lineage, or fork ancestry
 * (E12 §4 — a copied conversation does not copy authority). The host source is
 * carried as a session RELATION annotation for rendering (E12 §50) — and, per
 * the amendment, the authoritative DESTRUCTIVE/NON-INHERITING boundary sources
 * (`clear`, `fork`) outrank the same-session ownership shortcut: a reused
 * session_id across a /clear or fork boundary can never re-derive writable
 * authority from identity equality alone.
 *
 * Source precedence (amendment §13, deterministic):
 *   clear  → boundary handling: this session's ownership converges to
 *            detached (the SessionStart hook performs the named detach);
 *            NEVER same_owner_attached, generation unchanged (clear is a
 *            detach, not a takeover).
 *   fork   → boundary handling: NEVER authority inheritance and NEVER a
 *            mutation of the original owner's binding (even under a
 *            contract-violating reused session_id the outcome is
 *            fork_non_inheriting, never same_owner_attached).
 *   resume → exact same-owner detached reattach may occur (handler-gated).
 *   compact/startup/unknown → identity-based classification (frozen E12).
 *
 * Mutation rules (E12 §51, amendment §4): the SessionStart hook performs
 * exactly ONE automatic binding family change — the clear-boundary detach it
 * performs for relation=clear, and the same_owner_detached_resume reattach it
 * performs only when the host relation proves an actual resume. Every other
 * outcome is read-only until the explicit user-authorized takeover;
 * compaction (and every other attached-owner case) is zero-mutation.
 *
 * Outcome precedence (deterministic; E12 §29 — "a current exact binding may
 * disambiguate its own Run"):
 *   1. attached binding of this session on an ACTIVE run    →
 *        clear → cleared_detached; fork → fork_non_inheriting;
 *        otherwise same_owner_attached
 *   2. attached binding of this session on a TERMINAL run   → terminal_run
 *   3. detached binding of this session on an ACTIVE run    →
 *        clear → cleared_detached; fork → fork_non_inheriting;
 *        otherwise same_owner_detached_resume
 *   4. detached binding of this session on a TERMINAL run   → terminal_run
 *   5. >1 active runs visible in this workspace             → ambiguous_active_runs
 *   6. exactly 1 active run                                 →
 *        binding owned by another session → different_session_owner_exists
 *        no binding                       → active_run_unbound
 *   7. no active run anywhere                               → no_execution_run
 */

import { getExecutionRunInTx } from "../store/execution-runs.js";
import {
  getSupervisorBindingInTx,
  listActiveExecutionRunsForWorkspaceInTx,
  listSupervisorBindingsForSessionInTx,
} from "../store/supervisor-bindings.js";
import type { SessionStartSource } from "../hooks/parse.js";
import type { StoreTx } from "../store/transaction.js";

export type ExecutionSessionStartOutcome =
  | "same_owner_attached"
  | "same_owner_detached_resume"
  /** Amendment §4 — the /clear boundary: this session's ownership converges to detached. */
  | "cleared_detached"
  /** Amendment §9 — the fork boundary: no inheritance, original owner never mutated. */
  | "fork_non_inheriting"
  | "different_session_owner_exists"
  | "active_run_unbound"
  | "ambiguous_active_runs"
  | "terminal_run"
  | "no_execution_run";

/**
 * E12 §53 — the session relation annotation. Derived ONLY from the host's
 * authoritative SessionStart source field; "unknown" when the host proves
 * nothing (fork has no dedicated host signal). Never authority, never
 * persisted (E12 §54).
 */
export type ExecutionSessionRelation = "resume" | "clear" | "fork" | "compact" | "startup" | "unknown";

export function sessionRelationOfSource(source: SessionStartSource): ExecutionSessionRelation {
  switch (source) {
    case "resume":
      return "resume";
    case "clear":
      return "clear";
    case "fork":
      return "fork";
    case "compact":
      return "compact";
    case "startup":
      return "startup";
    default:
      return "unknown";
  }
}

export interface ExecutionSessionStartClassification {
  outcome: ExecutionSessionStartOutcome;
  /** The run the outcome names (null for no_execution_run/ambiguous). */
  executionRunId: string | null;
  binding: { state: "attached" | "detached"; generation: number; sessionId: string } | null;
  ownership: "current-session" | "other-session" | "none";
  relation: ExecutionSessionRelation;
  /** E12 §29 — every active-run candidate, set ONLY for ambiguous_active_runs. */
  ambiguousRunIds: string[];
}

export interface ClassifyExecutionSessionStartInput {
  sessionId: string;
  workspaceId: string;
  source: SessionStartSource;
}

const ACTIVE_LIFECYCLE = "active";

export function classifyExecutionSessionStartInTx(
  tx: StoreTx,
  input: ClassifyExecutionSessionStartInput,
): ExecutionSessionStartClassification {
  const relation = sessionRelationOfSource(input.source);
  const base = { relation };
  // The session's own bindings in THIS workspace (E12 §8 — workspace exact).
  const ownBindings = listSupervisorBindingsForSessionInTx(tx, input.sessionId).filter(
    (binding) => binding.workspaceId === input.workspaceId,
  );
  for (const binding of ownBindings) {
    if (binding.state !== "attached") continue;
    const run = getExecutionRunInTx(tx, binding.executionRunId);
    if (run === null) continue;
    if (run.lifecycle === ACTIVE_LIFECYCLE) {
      // Amendment §13 — the authoritative boundary outranks the same-session
      // ownership shortcut: clear reports the detach this boundary performs,
      // fork reports non-inheritance; neither can return same_owner_attached.
      // The binding field reports the Store row AS FOUND: for relation=clear
      // the SessionStart hook converges the attached row to detached before
      // rendering, so the rendered capsule always shows the detached state.
      const boundary = relation === "clear" || relation === "fork";
      return {
        ...base,
        outcome:
          relation === "clear"
            ? "cleared_detached"
            : relation === "fork"
              ? "fork_non_inheriting"
              : "same_owner_attached",
        executionRunId: binding.executionRunId,
        binding: { state: binding.state, generation: binding.generation, sessionId: binding.sessionId },
        ownership: boundary ? "none" : "current-session",
        ambiguousRunIds: [],
      };
    }
    return {
      ...base,
      outcome: "terminal_run",
      executionRunId: binding.executionRunId,
      binding: { state: binding.state, generation: binding.generation, sessionId: binding.sessionId },
      ownership: "current-session",
      ambiguousRunIds: [],
    };
  }
  for (const binding of ownBindings) {
    if (binding.state !== "detached") continue;
    const run = getExecutionRunInTx(tx, binding.executionRunId);
    if (run === null) continue;
    if (run.lifecycle === ACTIVE_LIFECYCLE) {
      // Amendment §4/§13 — under a clear boundary an already-detached own row
      // is the post-boundary state (cleared_detached, no mutation, never the
      // resume class); under fork it is equally non-inheriting. Only the
      // resume relation keeps the resumable outcome.
      const boundary = relation === "clear" || relation === "fork";
      return {
        ...base,
        outcome:
          relation === "clear"
            ? "cleared_detached"
            : relation === "fork"
              ? "fork_non_inheriting"
              : "same_owner_detached_resume",
        executionRunId: binding.executionRunId,
        binding: { state: binding.state, generation: binding.generation, sessionId: binding.sessionId },
        ownership: boundary ? "none" : "current-session",
        ambiguousRunIds: [],
      };
    }
    return {
      ...base,
      outcome: "terminal_run",
      executionRunId: binding.executionRunId,
      binding: { state: binding.state, generation: binding.generation, sessionId: binding.sessionId },
      ownership: "current-session",
      ambiguousRunIds: [],
    };
  }
  // No exact binding of this session disambiguates: the workspace's active
  // runs decide (E12 §29 — never an implicit selection).
  const activeRuns = listActiveExecutionRunsForWorkspaceInTx(tx, input.workspaceId);
  if (activeRuns.length > 1) {
    return {
      ...base,
      outcome: "ambiguous_active_runs",
      executionRunId: null,
      binding: null,
      ownership: "none",
      ambiguousRunIds: activeRuns.map((run) => run.executionRunId),
    };
  }
  if (activeRuns.length === 1) {
    const binding = getSupervisorBindingInTx(tx, activeRuns[0]!.executionRunId);
    return {
      ...base,
      outcome: binding === null ? "active_run_unbound" : "different_session_owner_exists",
      executionRunId: activeRuns[0]!.executionRunId,
      binding:
        binding === null
          ? null
          : { state: binding.state, generation: binding.generation, sessionId: binding.sessionId },
      ownership: binding === null ? "none" : "other-session",
      ambiguousRunIds: [],
    };
  }
  return {
    ...base,
    outcome: "no_execution_run",
    executionRunId: null,
    binding: null,
    ownership: "none",
    ambiguousRunIds: [],
  };
}
