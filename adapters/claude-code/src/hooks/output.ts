/**
 * Hook output construction + stdout discipline (Phase 7 directive §34).
 *
 * stdout carries EXACTLY ONE valid hook JSON object — never diagnostics,
 * never debug logs. Diagnostics go to stderr. Every hook response is built
 * here so no handler can accidentally pollute the protocol stream.
 */

export type HookOutput =
  | { kind: "empty" }
  | { kind: "json"; payload: Record<string, unknown> };

export function emptyOutput(): HookOutput {
  return { kind: "empty" };
}

export function jsonOutput(payload: Record<string, unknown>): HookOutput {
  return { kind: "json", payload };
}

/** additionalContext for SessionStart / UserPromptExpansion. */
export function contextOutput(hookEventName: string, additionalContext: string): HookOutput {
  return jsonOutput({
    hookSpecificOutput: { hookEventName, additionalContext },
  });
}

/** PreToolUse: block the tool call with a machine-readable reason (exit-0 JSON path). */
export function denyTool(hookEventName: string, reason: string): HookOutput {
  return jsonOutput({
    hookSpecificOutput: {
      hookEventName,
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

/**
 * PreToolUse: force the permission prompt and replace the tool's arguments.
 * For start_or_resume this "ask" exists solely to trigger PermissionRequest
 * so the session can transition to Plan Mode (directive §14); it is never a
 * design approval.
 */
export function askWithUpdatedInput(hookEventName: string, updatedInput: Record<string, unknown>, reason: string): HookOutput {
  return jsonOutput({
    hookSpecificOutput: {
      hookEventName,
      permissionDecision: "ask",
      permissionDecisionReason: reason,
      updatedInput,
    },
  });
}

/** PreToolUse: replace arguments without forcing any permission decision (read paths). */
export function updatedInputNoDecision(hookEventName: string, updatedInput: Record<string, unknown>): HookOutput {
  return jsonOutput({
    hookSpecificOutput: {
      hookEventName,
      updatedInput,
    },
  });
}

export interface PermissionUpdateEntry {
  type: string;
  mode?: string;
  destination?: string;
  [key: string]: unknown;
}

/**
 * PermissionRequest: allow the call and apply permission updates — the
 * session-scoped Plan Mode transition (directive §15). Only ever emitted for
 * start_or_resume after full re-verification.
 */
export function allowWithPermissions(updatedPermissions: PermissionUpdateEntry[]): HookOutput {
  return jsonOutput({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "allow",
        updatedPermissions,
      },
    },
  });
}

/** PermissionRequest: deny through the decision object (exit 2 is not honored here). */
export function denyPermissionRequest(reason: string): HookOutput {
  return jsonOutput({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "deny",
        reason,
      },
    },
  });
}

/** UserPromptSubmit: block the prompt with the exact directive §39 reason. */
export function blockPrompt(reason: string): HookOutput {
  return jsonOutput({ decision: "block", reason });
}

/** The frozen UserPromptSubmit drift-guard reason (directive §39). */
export const DRIFT_GUARD_REASON =
  "An active Phase Plan run requires Claude Plan Mode. Invoke /phase-plan to restore planning mode.";

/** The frozen ExitPlanMode deny reason (directive §41). */
export const EXIT_PLAN_MODE_REASON =
  "Phase Plan has not completed Final Approval/Handoff. The PlanningRun is still active; ExitPlanMode cannot end it.";

/** Serialize a HookOutput for stdout. Empty outputs write nothing. */
export function renderHookOutput(output: HookOutput): string {
  return output.kind === "json" ? JSON.stringify(output.payload) : "";
}
