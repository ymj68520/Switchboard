/**
 * Canonical ValidationReport hash (Phase 2G brief §24).
 *
 * Canonicalization is the SAME contract as every other derived artifact hash
 * (transaction/hash.ts + synthesis/hash.ts): `stableStringify` — object keys
 * sorted lexicographically, `undefined` fields dropped, arrays kept in order
 * (finding order is semantic), SHA-256 over the UTF-8 canonical serialization.
 *
 * INCLUDED: planID, input ref, inputHash, manifest ref (id + revision),
 * manifestHash, baseSnapshot, validatorProtocol, validatorModel (when the
 * runtime records one — a different recorded model identity therefore changes
 * the hash), result, findings (category, statement, scope, manifestItem,
 * sources, Harness-assigned finding ids).
 * EXCLUDED: id, createdAt, hash itself — the existing derived-hash convention
 * (§24: "exclude ... pure persistence id/timestamp if the existing derived
 * hash convention excludes them" — it does).
 */
import { createHash } from "node:crypto";

import { stableStringify } from "../core/invariants.js";
import type { SemanticValidationFinding, ValidationResult, ValidationReport } from "./types.js";

export interface ValidationReportHashPayload {
  planID: ValidationReport["planID"];
  input: ValidationReport["input"];
  inputHash: string;
  manifest: ValidationReport["manifest"];
  manifestHash: string;
  baseSnapshot: ValidationReport["baseSnapshot"];
  validatorProtocol: string;
  validatorModel?: string;
  result: ValidationResult;
  findings: SemanticValidationFinding[];
}

export function validationReportHashPayload(
  report: Omit<ValidationReport, "id" | "createdAt" | "hash">,
): ValidationReportHashPayload {
  return {
    planID: report.planID,
    input: report.input,
    inputHash: report.inputHash,
    manifest: report.manifest,
    manifestHash: report.manifestHash,
    baseSnapshot: report.baseSnapshot,
    validatorProtocol: report.validatorProtocol,
    ...(report.validatorModel !== undefined ? { validatorModel: report.validatorModel } : {}),
    result: report.result,
    findings: report.findings,
  };
}

export function computeValidationReportHash(
  payload: ValidationReportHashPayload,
): string {
  const hash = createHash("sha256");
  hash.update(stableStringify(payload));
  return hash.digest("hex");
}

/** Stored-record recompute for durable fail-closed loading (brief §29). */
export function computeValidationReportHashFromRecord(
  report: Omit<ValidationReport, "id" | "createdAt" | "hash">,
): string {
  return computeValidationReportHash(validationReportHashPayload(report));
}
