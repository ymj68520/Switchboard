/**
 * Centralized Claude Code compatibility policy (frozen plan §7.4).
 *
 * This module is the SINGLE place where Claude version → capability
 * judgments are made. Later phases must call into it instead of sprinkling
 * version comparisons through business code.
 *
 * The policy is per-capability, not one global minimum: the formal Approval
 * security boundary (`requiredUserInteraction`, spec §13) is gated much
 * tighter than general platform features. Every entry states its evidence;
 * capabilities whose first-support version cannot be reliably determined
 * from official evidence use `verification: "unknown"` and can never be
 * reported as PASS from a version number alone — UNKNOWN ≠ SUPPORTED, and a
 * critical UNKNOWN fails closed (architecture §13.4).
 */

import type { ClaudeVersionResult } from "../claude/version.js";
import { compareSemver } from "../runtime/node-version.js";
import { proofFreshness, type CapabilityProofs } from "../host/capability-proofs.js";

/** Capabilities whose PASS can only come from a real-host runtime proof. */
const RUNTIME_PROVEN_CAPABILITIES = ["planModeIntegration", "hookLifecycle"] as const;

type RuntimeProvenCapability = (typeof RUNTIME_PROVEN_CAPABILITIES)[number];

function runtimeProofFlag(capability: RuntimeProvenCapability): keyof CapabilityProofs {
  return capability === "planModeIntegration" ? "planModeIntegrationVerified" : "hookLifecycleVerified";
}

export const CLAUDE_CAPABILITY_NAMES = [
  "plugins",
  "stdioMcp",
  "planModeIntegration",
  "requiredUserInteraction",
  "hookLifecycle",
] as const;

export type ClaudeCapabilityName = (typeof CLAUDE_CAPABILITY_NAMES)[number];

export type CapabilityVerification = "version" | "runtime_probe" | "unknown";

export type CapabilityStatus = "PASS" | "FAIL" | "UNKNOWN";

/**
 * Version floor for the formal Approval interaction primitive. This is the
 * fail-closed security gate: below it, mandatory-user-interaction metadata
 * cannot be relied on, so transactional approval must not be attempted.
 */
export const REQUIRED_USER_INTERACTION_VERSION = "2.1.199";

export interface CapabilityPolicyEntry {
  id: ClaudeCapabilityName;
  /** Present only when verification === "version". */
  minimumVersion?: string;
  verification: CapabilityVerification;
  /** Critical capabilities gate overall compatibility and fail closed. */
  critical: boolean;
  /** Why Phase Plan requires this capability (architecture basis). */
  reason: string;
  /** Evidence for the chosen floor, or why the floor is unknown. */
  evidence: string;
}

/**
 * The capability compatibility matrix. Order is stable — it is the doctor
 * report rendering order. No other module may encode version gates for
 * Claude capabilities.
 */
export const CAPABILITY_POLICY: readonly CapabilityPolicyEntry[] = [
  {
    id: "plugins",
    verification: "version",
    minimumVersion: "2.0.0",
    critical: true,
    reason: "Phase Plan ships as a Claude Code plugin; the plugin system must load .claude-plugin and its skills/agents",
    evidence:
      "plugin system and plugin marketplace GA together with Claude Code v2.0.0 (official release notes, 2025-09)",
  },
  {
    id: "stdioMcp",
    verification: "version",
    minimumVersion: "2.0.0",
    critical: true,
    reason: "the model-facing Phase Plan API is a plugin-scoped stdio MCP server (.mcp.json in the plugin root)",
    evidence:
      "plugin-scoped .mcp.json server registration ships with the plugin system (GA with Claude Code v2.0.0, 2025-09)",
  },
  {
    id: "planModeIntegration",
    verification: "unknown",
    critical: false,
    reason:
      "session-scoped plan permission anchors the planning/execution boundary (spec §6); Plan Mode is the host-owned boundary and Phase Plan guards (§6.3) remain the fail-closed backstop without it",
    evidence:
      "no reliable official evidence pins the first version supporting the exact session-scoped plan-mode transition behavior; must be proven by a runtime probe (Phase 2) before any PASS is claimed",
  },
  {
    id: "requiredUserInteraction",
    verification: "version",
    minimumVersion: REQUIRED_USER_INTERACTION_VERSION,
    critical: true,
    reason:
      "formal Proposal Approval requires reliable mandatory-user-interaction tool metadata; below this floor Phase Plan must fail closed (spec §13.1/§13.4)",
    evidence:
      "Phase Plan capability correction directive 2026-09-24; official changelog documents requiresUserInteraction tool-metadata handling (allow-rule bypass fix) by 2.1.246, corroborating the mechanism's presence in the 2.1.x line",
  },
  {
    id: "hookLifecycle",
    verification: "unknown",
    critical: false,
    reason:
      "guards, observation capture, and context injection ride the Claude hook lifecycle (spec §29.2); their absence degrades observation/recovery UX but not the fail-closed write boundary (Plan Mode primary + Core authority)",
    evidence:
      "no reliable official evidence pins the first version supporting the exact Phase Plan hook event set; must be proven by a runtime probe (Phase 2) before any PASS is claimed",
  },
] as const;

export interface CapabilityCheck {
  status: CapabilityStatus;
  reason: string;
  /** Evidence/basis behind this judgment (from the policy entry). */
  basis: string;
  /** How the status was established (version floor vs real-host runtime proof). */
  via?: "version" | "runtime-probe";
}

export interface ClaudeCapabilityReport {
  version?: string;
  supported: boolean;
  capabilities: Record<ClaudeCapabilityName, CapabilityCheck>;
  policy: {
    /** Convenience accessor for the approval fail-closed floor. */
    approvalInteractionFloor: string;
    entries: readonly CapabilityPolicyEntry[];
  };
}

function evaluate(
  entry: CapabilityPolicyEntry,
  versionResult: ClaudeVersionResult,
  runtimeProof?: CapabilityProofs | null,
): CapabilityCheck {
  if (entry.verification === "unknown") {
    // A runtime proof from a REAL host probe is the only path from UNKNOWN to
    // PASS for these capabilities — and only for the exact same Claude
    // version the proof was recorded on (directive §46/§47). Doctor never
    // executes the probe and never invents a version floor.
    if (
      runtimeProof !== undefined &&
      runtimeProof !== null &&
      (RUNTIME_PROVEN_CAPABILITIES as readonly string[]).includes(entry.id) &&
      proofFreshness(runtimeProof, versionResult.status === "ok" ? versionResult.version : undefined) === "current" &&
      runtimeProof[runtimeProofFlag(entry.id as RuntimeProvenCapability)]
    ) {
      return {
        status: "PASS",
        reason: `${entry.id} PASS (runtime verified on Claude Code ${runtimeProof.claudeVersion}, probe recorded ${runtimeProof.verifiedAt})`,
        basis: entry.evidence,
        via: "runtime-probe",
      };
    }
    return {
      status: "UNKNOWN",
      reason: "cannot be proven from a version number — no verified official floor; runtime probe required",
      basis: entry.evidence,
    };
  }
  if (versionResult.status === "not_found") {
    return {
      status: "UNKNOWN",
      reason: "Claude Code CLI not found — capability cannot be proven",
      basis: entry.evidence,
    };
  }
  if (versionResult.status === "unreadable") {
    return {
      status: "UNKNOWN",
      reason: `Claude Code version unreadable (${versionResult.reason}) — capability cannot be proven`,
      basis: entry.evidence,
    };
  }
  const minimum = entry.minimumVersion;
  if (minimum === undefined) {
    // A "version"-verified entry without a floor is a policy bug: fail closed.
    return {
      status: "UNKNOWN",
      reason: "policy entry is version-verified but has no floor — fail closed",
      basis: entry.evidence,
    };
  }
  const supported = compareSemver(versionResult.version, minimum) >= 0;
  return supported
    ? {
        status: "PASS",
        reason: `Claude Code ${versionResult.version} satisfies the ${entry.id} floor ${minimum}`,
        basis: entry.evidence,
      }
    : {
        status: "FAIL",
        reason: `Claude Code ${versionResult.version} is below the ${entry.id} floor ${minimum}`,
        basis: entry.evidence,
      };
}

/**
 * Evaluate every capability for the detected CLI. `supported` is true only
 * when every CRITICAL capability is a proven PASS — a critical UNKNOWN or
 * FAIL closes the gate (architecture §13.4). Non-critical UNKNOWN entries
 * are reported honestly but do not claim support and do not block readiness.
 */
export function evaluateClaudeCapabilities(
  versionResult: ClaudeVersionResult,
  policy: readonly CapabilityPolicyEntry[] = CAPABILITY_POLICY,
  runtimeProof?: CapabilityProofs | null,
): ClaudeCapabilityReport {
  const capabilities = {} as Record<ClaudeCapabilityName, CapabilityCheck>;
  for (const entry of policy) {
    capabilities[entry.id] = evaluate(entry, versionResult, runtimeProof);
  }
  const version = versionResult.status === "ok" ? versionResult.version : undefined;
  const supported = policy
    .filter((entry) => entry.critical)
    .every((entry) => capabilities[entry.id].status === "PASS");
  return {
    ...(version === undefined ? {} : { version }),
    supported,
    capabilities,
    policy: {
      approvalInteractionFloor: REQUIRED_USER_INTERACTION_VERSION,
      entries: policy,
    },
  };
}
