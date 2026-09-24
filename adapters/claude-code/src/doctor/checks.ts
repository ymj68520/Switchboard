/**
 * Doctor check model and individual check builders (frozen plan §6–§9).
 * Checks are pure functions over probe results; the doctor orchestrator
 * (doctor.ts) owns probing. Statuses: PASS / FAIL / UNKNOWN / NOT_ACTIVE —
 * NOT_ACTIVE means "expected only inside a Claude plugin session", which is
 * informational and never fails the doctor by itself.
 */

import type { RuntimeErrorCode } from "../runtime/errors.js";
import type { ClaudeVersionResult } from "../claude/version.js";
import type { ClaudeCapabilityReport } from "./capabilities.js";
import type {
  PluginDataPreflightResult,
  PluginEnvironmentReport,
} from "../claude/environment.js";
import {
  compareSemver,
  isNodeVersionSupported,
  REQUIRED_NODE_VERSION,
} from "../runtime/node-version.js";
import type { SqliteCapabilityResult } from "../store/sqlite-capability.js";

export type CheckId =
  | "node.version"
  | "node.sqlite"
  | "claude.cli"
  | "claude.capabilities"
  | "claude.plugin_environment"
  | "claude.plugin_data";

export type CheckStatus = "PASS" | "FAIL" | "UNKNOWN" | "NOT_ACTIVE";

export type CheckTier = "runtime" | "host";

export interface CheckOutcome {
  id: CheckId;
  label: string;
  tier: CheckTier;
  status: CheckStatus;
  /**
   * Required checks gate overall readiness and the doctor exit code.
   * NOT_ACTIVE plugin-session checks are required=false.
   */
  required: boolean;
  errorCode?: RuntimeErrorCode;
  message?: string;
  /** Stable, JSON-serializable extra facts (rendered in doctor --json). */
  detail?: Record<string, unknown>;
}

export function checkNodeVersion(detected: string): CheckOutcome {
  const supported = isNodeVersionSupported(detected);
  return {
    id: "node.version",
    label: "node",
    tier: "runtime",
    status: supported ? "PASS" : "FAIL",
    required: true,
    ...(supported ? {} : { errorCode: "UNSUPPORTED_NODE_VERSION" as const }),
    message: supported
      ? `detected ${detected} (required >= ${REQUIRED_NODE_VERSION})`
      : `detected ${detected} is below the required ${REQUIRED_NODE_VERSION}`,
    detail: {
      detected,
      required: REQUIRED_NODE_VERSION,
      comparison: (() => {
        try {
          return compareSemver(detected, REQUIRED_NODE_VERSION) >= 0 ? ">= required" : "< required";
        } catch {
          return "unparseable";
        }
      })(),
    },
  };
}

export function checkSqliteCapability(result: SqliteCapabilityResult): CheckOutcome {
  return {
    id: "node.sqlite",
    label: "node:sqlite",
    tier: "runtime",
    status: result.available ? "PASS" : "FAIL",
    required: true,
    ...(result.available ? {} : { errorCode: "SQLITE_UNAVAILABLE" as const }),
    message: result.available
      ? `in-memory smoke test passed${result.sqliteVersion ? ` (SQLite ${result.sqliteVersion})` : ""}`
      : `smoke test failed at '${result.failedStep}': ${result.cause ?? "unknown"}`,
    detail: { steps: { ...result.steps }, ...(result.sqliteVersion ? { sqliteVersion: result.sqliteVersion } : {}), ...(result.failedStep ? { failedStep: result.failedStep } : {}), ...(result.cause ? { cause: result.cause } : {}) },
  };
}

export function checkClaudeCli(result: ClaudeVersionResult): CheckOutcome {
  if (result.status === "ok") {
    return {
      id: "claude.cli",
      label: "Claude Code CLI",
      tier: "host",
      status: "PASS",
      required: true,
      message: `Claude Code ${result.version} (${result.binPath})`,
      detail: { version: result.version, binPath: result.binPath, raw: result.raw },
    };
  }
  if (result.status === "not_found") {
    return {
      id: "claude.cli",
      label: "Claude Code CLI",
      tier: "host",
      status: "FAIL",
      required: true,
      errorCode: "CLAUDE_CLI_NOT_FOUND",
      message: "claude executable not found on PATH (set PHASE_PLAN_CLAUDE_BIN to override)",
      detail: { attempted: result.attempted },
    };
  }
  return {
    id: "claude.cli",
    label: "Claude Code CLI",
    tier: "host",
    status: "FAIL",
    required: true,
    errorCode: "CLAUDE_VERSION_UNREADABLE",
    message: `claude version unreadable: ${result.reason}`,
    detail: {
      ...(result.raw === undefined ? {} : { raw: result.raw }),
      ...(result.binPath === undefined ? {} : { binPath: result.binPath }),
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    },
  };
}

export function checkClaudeCapabilities(report: ClaudeCapabilityReport): CheckOutcome {
  const failed = Object.entries(report.capabilities)
    .filter(([, check]) => check.status !== "PASS")
    .map(([name, check]) => `${name}: ${check.status} — ${check.reason}`);
  return {
    id: "claude.capabilities",
    label: "Claude capabilities",
    tier: "host",
    status: report.supported ? "PASS" : "FAIL",
    required: true,
    ...(report.supported ? {} : { errorCode: "CLAUDE_CAPABILITY_UNSUPPORTED" as const }),
    message: report.supported
      ? `all capabilities PASS (policy minimum ${report.policy.minimumVersion})`
      : failed.join("; "),
    detail: {
      policy: { ...report.policy },
      capabilities: Object.fromEntries(
        Object.entries(report.capabilities).map(([name, check]) => [
          name,
          { status: check.status, reason: check.reason },
        ]),
      ),
    },
  };
}

export function checkPluginEnvironment(report: PluginEnvironmentReport): CheckOutcome {
  return {
    id: "claude.plugin_environment",
    label: "plugin environment",
    tier: "host",
    status: report.status === "ACTIVE" ? "PASS" : "NOT_ACTIVE",
    required: false,
    message:
      report.status === "ACTIVE"
        ? "Claude plugin environment variables detected"
        : "expected only inside a Claude Code plugin session",
    detail: {
      variables: report.variables.map((v) => ({
        name: v.name,
        classification: v.classification,
        present: v.present,
        ...(v.present && v.value !== undefined ? { value: v.value } : {}),
      })),
    },
  };
}

export function checkPluginData(
  envHasDataPath: boolean,
  preflight: PluginDataPreflightResult | null,
): CheckOutcome {
  if (!envHasDataPath || preflight === null) {
    return {
      id: "claude.plugin_data",
      label: "plugin data",
      tier: "host",
      status: "NOT_ACTIVE",
      required: false,
      message: "CLAUDE_PLUGIN_DATA not set — persistent storage preflight skipped (plugin session only)",
    };
  }
  if (preflight.status === "ok") {
    return {
      id: "claude.plugin_data",
      label: "plugin data",
      tier: "host",
      status: "PASS",
      required: true,
      message: `${preflight.resolvedRoot} is writable${preflight.createdRoot ? " (created)" : ""}`,
      detail: {
        resolvedRoot: preflight.resolvedRoot,
        createdRoot: preflight.createdRoot,
        createdDirs: [...preflight.createdDirs],
      },
    };
  }
  return {
    id: "claude.plugin_data",
    label: "plugin data",
    tier: "host",
    status: "FAIL",
    required: true,
    errorCode: preflight.errorCode,
    message: preflight.message,
  };
}
