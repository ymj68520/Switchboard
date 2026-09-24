/**
 * Doctor report model and rendering (frozen plan §6, §8, §14).
 *
 * The JSON report is a stable machine-readable contract: fixed schema
 * version, fixed key order, no timestamps — identical inputs always render
 * byte-identical output. The process exit code is derived from the SAME
 * report so JSON and exit semantics cannot drift.
 */

import { EXIT_CODES, exitCodeForError, type ExitCode } from "../runtime/exit-codes.js";
import { RUNTIME_NAME, RUNTIME_VERSION } from "../runtime/version.js";
import type { CheckOutcome } from "./checks.js";

export const DOCTOR_REPORT_SCHEMA = "phase-plan.doctor-report/1" as const;

export type OverallReadiness = "READY" | "NOT_READY";
export type HostIntegrationStatus = "ACTIVE" | "NOT_ACTIVE" | "NOT_READY";

export interface DoctorReport {
  schema: typeof DOCTOR_REPORT_SCHEMA;
  runtime: { name: string; version: string };
  overall: OverallReadiness;
  hostIntegration: HostIntegrationStatus;
  checks: {
    node: CheckOutcome;
    sqlite: CheckOutcome;
    claudeCli: CheckOutcome;
    claudeCapabilities: CheckOutcome;
    pluginEnvironment: CheckOutcome;
    pluginData: CheckOutcome;
  };
}

/**
 * Canonical check order used for both human rendering and exit-code
 * derivation: the first failing required check decides the doctor exit code.
 */
export const CHECK_ORDER: readonly (keyof DoctorReport["checks"])[] = [
  "node",
  "sqlite",
  "claudeCli",
  "claudeCapabilities",
  "pluginEnvironment",
  "pluginData",
];

export function deriveOverallReadiness(report: DoctorReport): OverallReadiness {
  return CHECK_ORDER.every((key) => {
    const check = report.checks[key];
    return !check.required || check.status === "PASS";
  })
    ? "READY"
    : "NOT_READY";
}

export function deriveHostIntegration(report: DoctorReport): HostIntegrationStatus {
  const { claudeCli, claudeCapabilities, pluginEnvironment, pluginData } = report.checks;
  const blocking = [claudeCli, claudeCapabilities, pluginData].some(
    (check) => check.required && check.status !== "PASS",
  );
  if (blocking) return "NOT_READY";
  return pluginEnvironment.status === "NOT_ACTIVE" ? "NOT_ACTIVE" : "ACTIVE";
}

export function doctorExitCode(report: DoctorReport): ExitCode {
  for (const key of CHECK_ORDER) {
    const check = report.checks[key];
    if (check.required && check.status !== "PASS" && check.errorCode !== undefined) {
      return exitCodeForError(check.errorCode);
    }
  }
  return EXIT_CODES.success;
}

export function renderJsonReport(report: DoctorReport): string {
  // Key order follows construction order; keep DoctorReport literals stable.
  return JSON.stringify(report, null, 2) + "\n";
}

export function renderHumanReport(report: DoctorReport): string {
  const { checks } = report;
  const lines: string[] = [];
  lines.push(`Phase Plan runtime doctor (${RUNTIME_NAME} v${RUNTIME_VERSION})`);
  lines.push("");
  lines.push("Runtime:");
  lines.push(...renderCheck(checks.node));
  lines.push(...renderCheck(checks.sqlite));
  lines.push("Claude host:");
  lines.push(...renderCheck(checks.claudeCli));
  lines.push(...renderCheck(checks.claudeCapabilities));
  lines.push(...renderCheck(checks.pluginEnvironment));
  lines.push(...renderCheck(checks.pluginData));
  lines.push("");
  lines.push(`Overall runtime: ${report.overall === "READY" ? "READY" : "NOT READY"}`);
  lines.push(
    report.hostIntegration === "ACTIVE"
      ? "Claude integration: ACTIVE"
      : report.hostIntegration === "NOT_ACTIVE"
        ? "Claude integration: NOT CURRENTLY INSIDE A PLUGIN SESSION"
        : "Claude integration: NOT READY",
  );
  return lines.join("\n") + "\n";
}

function renderCheck(check: CheckOutcome): string[] {
  const lines = [`  ${check.label.padEnd(20)} ${check.status.padEnd(11)} ${check.message ?? ""}`];
  if (check.id === "claude.capabilities" && check.status !== "PASS") {
    const capabilities = check.detail?.capabilities as
      | Record<string, { status: string; reason: string }>
      | undefined;
    if (capabilities) {
      for (const [name, cap] of Object.entries(capabilities)) {
        if (cap.status !== "PASS") {
          lines.push(`    - ${name}: ${cap.status} — ${cap.reason}`);
        }
      }
    }
  }
  return lines;
}
