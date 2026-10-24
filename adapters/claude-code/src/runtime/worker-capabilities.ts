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

export type EnforceabilityTier = "enforceable" | "advisory" | "unsupported";

export interface CapabilityEnforceabilityReportEntry {
  capability: string;
  granted: boolean;
  tier: EnforceabilityTier;
  mechanism: string;
}

/**
 * P2 — Complete honest enforceability report for a capability envelope.
 * Exposes whether restrictions are mechanically enforced by tool/process boundaries
 * or semantic constraints audited post-execution, preventing false security claims.
 */
export function capabilityEnforceabilityReport(
  envelope: ExecutionCapabilityEnvelope,
): CapabilityEnforceabilityReportEntry[] {
  return [
    {
      capability: "repositoryRead",
      granted: envelope.repositoryRead,
      tier: "enforceable",
      mechanism: "PreToolUse hook blocks Read/Glob/Grep/LS",
    },
    {
      capability: "repositoryWrite",
      granted: envelope.repositoryWrite,
      tier: "enforceable",
      mechanism: "PreToolUse hook blocks Edit/Write/MultiEdit/NotebookEdit",
    },
    {
      capability: "commandExecution",
      granted: envelope.commandExecution,
      tier: "enforceable",
      mechanism: "PreToolUse hook blocks Bash/PowerShell when false",
    },
    {
      capability: "networkAccess",
      granted: envelope.networkAccess,
      tier: envelope.commandExecution ? "advisory" : "enforceable",
      mechanism: envelope.commandExecution
        ? "WebFetch/WebSearch mechanically blocked; shell outbound network access intercepted at PreToolUse execution boundary; host OS network namespace is advisory without container sandbox"
        : "WebFetch/WebSearch mechanically blocked; no shell tool available (transitive complete isolation)",
    },
    {
      capability: "dependencyMutation",
      granted: envelope.dependencyMutation,
      tier: envelope.commandExecution ? "advisory" : "enforceable",
      mechanism: envelope.commandExecution
        ? "package manager mutation commands intercepted at PreToolUse boundary and audited; underlying filesystem permissions govern"
        : "no shell and no mutating tools available",
    },
    {
      capability: "gitCommit",
      granted: envelope.gitCommit,
      tier: envelope.commandExecution ? "enforceable" : "enforceable",
      mechanism: envelope.commandExecution
        ? "git commit commands in shell intercepted at PreToolUse execution boundary; ExecutionCommit is the sole recognized progression object"
        : "no shell available",
    },
    {
      capability: "gitPush",
      granted: envelope.gitPush,
      tier: envelope.commandExecution ? "enforceable" : "enforceable",
      mechanism: envelope.commandExecution
        ? "git push and remote commands in shell intercepted at PreToolUse execution boundary; remote push credentials withheld"
        : "no shell available",
    },
    {
      capability: "externalServiceMutation",
      granted: envelope.externalServiceMutation,
      tier: envelope.commandExecution ? "advisory" : "enforceable",
      mechanism: envelope.commandExecution
        ? "cloud/container CLI commands intercepted at PreToolUse boundary; external service credentials withheld"
        : "no shell available",
    },
  ];
}

/**
 * The narrowed decision for one worker tool call (E5 §23, amended for P2).
 * `denied` carries the Directive capability field that refused the tool; `uncategorized`
 * tools are denied fail-closed — the Worker surface is deliberately small (E5 §16).
 *
 * When commandExecution is enabled, inspects toolInput command strings for restricted
 * operations (gitPush, gitCommit, network commands, package manager mutations) and
 * enforces execution boundaries without relying solely on substring blacklists.
 */
export function narrowWorkerTool(
  logicalToolName: string,
  envelope: ExecutionCapabilityEnvelope,
  toolInput?: Record<string, unknown>,
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

  // P2: Execution boundary enforcement for shell commands when commandExecution is enabled
  if (
    (logicalToolName === "Bash" || logicalToolName === "PowerShell")
    && toolInput
    && typeof toolInput.command === "string"
  ) {
    const cmd = toolInput.command;

    // 1. gitPush boundary check
    if (!envelope.gitPush && (/\bgit\s+(push|remote)\b/i.test(cmd) || /\bgit-push\b/i.test(cmd))) {
      return {
        allowed: false,
        reason: "the bound Directive's capability envelope sets gitPush=false; git push operations are denied at the execution boundary (P2)",
        capability: "gitPush",
      };
    }

    // 2. gitCommit boundary check
    if (!envelope.gitCommit && /\bgit\s+commit\b/i.test(cmd)) {
      return {
        allowed: false,
        reason: "the bound Directive's capability envelope sets gitCommit=false; repository git commit operations are denied at the execution boundary (P2); progress advances via ExecutionCommit only",
        capability: "gitCommit",
      };
    }

    // 3. networkAccess boundary check
    if (
      !envelope.networkAccess
      && (
        /\b(curl|wget|nc|netcat|ssh|scp|ftp)\b/i.test(cmd)
        || /\bgit\s+(fetch|pull|clone|ls-remote)\b/i.test(cmd)
      )
    ) {
      return {
        allowed: false,
        reason: "the bound Directive's capability envelope sets networkAccess=false; outbound network commands are denied at the execution boundary (P2)",
        capability: "networkAccess",
      };
    }

    // 4. externalServiceMutation boundary check
    if (!envelope.externalServiceMutation && /\b(aws|gcloud|az|kubectl|docker\s+push)\b/i.test(cmd)) {
      return {
        allowed: false,
        reason: "the bound Directive's capability envelope sets externalServiceMutation=false; external service mutation commands are denied at the execution boundary (P2)",
        capability: "externalServiceMutation",
      };
    }

    // 5. dependencyMutation boundary check
    if (
      !envelope.dependencyMutation
      && /\b(npm\s+(install|i|add|update|uninstall)|yarn\s+(add|install|remove)|pip\s+install|cargo\s+add)\b/i.test(cmd)
    ) {
      return {
        allowed: false,
        reason: "the bound Directive's capability envelope sets dependencyMutation=false; package dependency mutation commands are denied at the execution boundary (P2)",
        capability: "dependencyMutation",
      };
    }
  }

  return { allowed: true };
}
