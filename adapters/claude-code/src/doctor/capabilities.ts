/**
 * Centralized Claude Code compatibility policy (frozen plan §7.4).
 *
 * This module is the SINGLE place where Claude version → capability
 * judgments are made. Later phases must call into it instead of sprinkling
 * version comparisons through business code. Every judgment carries an
 * explicit reason; inability to prove a capability yields UNKNOWN, which is
 * fail-closed for critical capabilities (architecture §13.4): an unreadable
 * version must never be reported as supported.
 */

import type { ClaudeVersionResult } from "../claude/version.js";

/**
 * Minimum Claude Code version for which Phase Plan v0.1 claims capability
 * compatibility. The plugin system, stdio MCP support, mandatory-interaction
 * tool metadata, and the hook lifecycle used by the frozen architecture are
 * all required; versions below this baseline are rejected as a matter of
 * policy. This number is policy, pinned here and in tests — nowhere else.
 */
export const MINIMUM_CLAUDE_CODE_VERSION = "2.0.0";

export const CLAUDE_CAPABILITY_NAMES = [
  "plugins",
  "stdioMcp",
  "planModeIntegration",
  "requiredUserInteraction",
  "hookLifecycle",
] as const;

export type ClaudeCapabilityName = (typeof CLAUDE_CAPABILITY_NAMES)[number];

export type CapabilityStatus = "PASS" | "FAIL" | "UNKNOWN";

export interface CapabilityCheck {
  status: CapabilityStatus;
  reason: string;
  /** What the judgment is based on (version policy today; live probes later). */
  basis: string;
}

export interface ClaudeCapabilityReport {
  version?: string;
  supported: boolean;
  capabilities: Record<ClaudeCapabilityName, CapabilityCheck>;
  policy: { minimumVersion: string };
}

const CAPABILITY_BASES: Readonly<Record<ClaudeCapabilityName, string>> = {
  plugins: "plugin system required to load Phase Plan as a Claude Code plugin",
  stdioMcp: "stdio MCP server transport is the Phase Plan model-facing API channel",
  planModeIntegration: "session-scoped Plan Mode transition anchors the planning/execution boundary",
  requiredUserInteraction: "formal Approval requires mandatory-user-interaction MCP metadata (architecture §13)",
  hookLifecycle: "guards, observation capture, and context injection run on the Claude hook lifecycle",
};

function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const ai = Number(pa[i] ?? 0);
    const bi = Number(pb[i] ?? 0);
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

function evaluate(
  name: ClaudeCapabilityName,
  versionResult: ClaudeVersionResult,
  minimumVersion: string,
): CapabilityCheck {
  const basis = CAPABILITY_BASES[name];
  if (versionResult.status === "not_found") {
    return {
      status: "UNKNOWN",
      reason: "Claude Code CLI not found — capability cannot be proven",
      basis,
    };
  }
  if (versionResult.status === "unreadable") {
    return {
      status: "UNKNOWN",
      reason: `Claude Code version unreadable (${versionResult.reason}) — capability cannot be proven`,
      basis,
    };
  }
  const supported = compareVersions(versionResult.version, minimumVersion) >= 0;
  return supported
    ? {
        status: "PASS",
        reason: `Claude Code ${versionResult.version} satisfies the policy minimum ${minimumVersion}`,
        basis,
      }
    : {
        status: "FAIL",
        reason: `Claude Code ${versionResult.version} is below the policy minimum ${minimumVersion}`,
        basis,
      };
}

/**
 * Evaluate all frozen capabilities for the detected CLI. `supported` is true
 * only when every critical capability is a proven PASS — UNKNOWN and FAIL
 * both fail closed.
 */
export function evaluateClaudeCapabilities(
  versionResult: ClaudeVersionResult,
  minimumVersion: string = MINIMUM_CLAUDE_CODE_VERSION,
): ClaudeCapabilityReport {
  const capabilities = {} as Record<ClaudeCapabilityName, CapabilityCheck>;
  for (const name of CLAUDE_CAPABILITY_NAMES) {
    capabilities[name] = evaluate(name, versionResult, minimumVersion);
  }
  const version = versionResult.status === "ok" ? versionResult.version : undefined;
  const supported = CLAUDE_CAPABILITY_NAMES.every((name) => capabilities[name].status === "PASS");
  return { ...(version === undefined ? {} : { version }), supported, capabilities, policy: { minimumVersion } };
}
