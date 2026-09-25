/**
 * Runtime capability proofs (Phase 7 directive §45–§47).
 *
 * Phase 1 left `planModeIntegration` and `hookLifecycle` as version-UNKNOWN
 * capabilities: no version floor can prove them. Phase 7 lets REAL host
 * behavior establish a per-install proof, stored at
 * ${CLAUDE_PLUGIN_DATA}/runtime/capability-proofs.json.
 *
 * Proofs are version-bound: when the detected Claude Code version differs
 * from proof.claudeVersion the proof no longer applies and the capability
 * falls back to UNKNOWN until a fresh probe succeeds (directive §46). Doctor
 * only READS proofs — it never executes an interactive probe and never
 * upgrades UNKNOWN to PASS from a version number alone.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const CAPABILITY_PROOF_VERSION = 1 as const;
export const CAPABILITY_PROOFS_FILE = "capability-proofs.json";

export interface CapabilityProofs {
  claudeVersion: string;
  proofVersion: typeof CAPABILITY_PROOF_VERSION;
  hookLifecycleVerified: boolean;
  planModeIntegrationVerified: boolean;
  verifiedAt: string;
}

export function capabilityProofsPath(pluginDataRoot: string): string {
  return path.join(pluginDataRoot, "runtime", CAPABILITY_PROOFS_FILE);
}

export function isValidCapabilityProofs(value: unknown): value is CapabilityProofs {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.claudeVersion === "string" &&
    record.claudeVersion !== "" &&
    record.proofVersion === CAPABILITY_PROOF_VERSION &&
    typeof record.hookLifecycleVerified === "boolean" &&
    typeof record.planModeIntegrationVerified === "boolean" &&
    typeof record.verifiedAt === "string" &&
    record.verifiedAt !== ""
  );
}

/**
 * Read the stored proof. Missing or corrupt proofs are advisory — the caller
 * sees null and every runtime capability stays UNKNOWN (never an error).
 */
export function readCapabilityProofs(pluginDataRoot: string): CapabilityProofs | null {
  let raw: string;
  try {
    raw = fs.readFileSync(capabilityProofsPath(pluginDataRoot), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isValidCapabilityProofs(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Atomic write (tmp file + rename) for the real-host probe procedure. */
export function writeCapabilityProofs(pluginDataRoot: string, proofs: CapabilityProofs): void {
  if (!isValidCapabilityProofs(proofs)) {
    throw new Error("refusing to write a malformed capability proof");
  }
  const filePath = capabilityProofsPath(pluginDataRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(proofs, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

export type ProofFreshness = "current" | "version-changed" | "absent";

/**
 * Directive §46: a proof recorded for a different Claude Code version must
 * not be reused — the caller reports UNKNOWN until a new probe succeeds.
 */
export function proofFreshness(proof: CapabilityProofs | null, currentClaudeVersion: string | undefined): ProofFreshness {
  if (proof === null) return "absent";
  if (currentClaudeVersion === undefined || proof.claudeVersion !== currentClaudeVersion) return "version-changed";
  return "current";
}
