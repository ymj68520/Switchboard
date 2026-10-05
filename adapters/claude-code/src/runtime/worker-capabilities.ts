/**
 * Worker tool classification + capability narrowing (v0.2.0 E5 §21–§26).
 *
 * PURE mapping tables shared by the PreToolUse hook guards. Two deterministic
 * rules govern everything here:
 *
 *   1. Phase Plan can only NARROW host authority, never elevate it (E5 §21) —
 *      an allowed tool simply falls through to Claude Code's native permission
 *      system, which remains the outer ceiling.
 *   2. Expected execution scope is NEVER consulted (E5 §26) — no path
 *      allowlist, no hard read/write authorization, no path-denial hook.
 *
 * The five semantic categories (networkAccess / dependencyMutation / gitCommit
 * / gitPush / externalServiceMutation) are enforced at LAUNCH time: an open
 * commandExecution=true shell cannot conservatively classify obfuscated
 * commands, so a Directive that pairs commandExecution=true with any of those
 * restrictions refuses to launch (CAPABILITY_ENFORCEMENT_UNAVAILABLE, E5
 * §24/§25). Consequently the runtime guard only ever narrows the four
 * tool-mappable categories below.
 */

import type { ExecutionCapabilityEnvelope } from "../core/execution-directive.js";

/** The generic subagent-launch tool names Claude Code exposes (E5 §19/§21). */
export const AGENT_LAUNCH_TOOLS = ["Task", "Agent"] as const;

/** Repository/runtime tools the SUPERVISOR may not use directly during supervised execution (E5 §19). */
export const SUPERVISOR_FORBIDDEN_DIRECT_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
  "PowerShell",
  "WebFetch",
  "WebSearch",
] as const;

export type WorkerCapabilityCategory =
  | "repositoryRead"
  | "repositoryWrite"
  | "commandExecution"
  | "networkAccess"
  | null;

/** Map a host tool to its coarse capability category; null = uncategorized. */
export function classifyWorkerTool(logicalToolName: string): WorkerCapabilityCategory {
  switch (logicalToolName) {
    case "Read":
    case "Glob":
    case "Grep":
    case "LS":
      return "repositoryRead";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return "repositoryWrite";
    case "Bash":
    case "PowerShell":
      return "commandExecution";
    case "WebFetch":
    case "WebSearch":
      return "networkAccess";
    default:
      return null;
  }
}

/**
 * The narrowed decision for one worker tool call (E5 §23). `denied` carries
 * the Directive capability field that refused the tool; `uncategorized` tools
 * are denied fail-closed — the Worker surface is deliberately small (E5 §16).
 */
export function narrowWorkerTool(
  logicalToolName: string,
  envelope: ExecutionCapabilityEnvelope,
): { allowed: true } | { allowed: false; reason: string; capability: string | null } {
  const category = classifyWorkerTool(logicalToolName);
  if (category === null) {
    return {
      allowed: false,
      reason: `tool '${logicalToolName}' is not part of the ExecutionWorker surface (repository read/write, shell, network, and the three phase_plan worker tools only)`,
      capability: null,
    };
  }
  if (!envelope[category]) {
    return {
      allowed: false,
      reason: `the bound Directive's capability envelope sets ${category}=false; '${logicalToolName}' is denied`,
      capability: category,
    };
  }
  return { allowed: true };
}
