/**
 * Strict Worker structured-output parsing — v0.2.0 Phase 7A (directive §35/§36).
 *
 * OpenCode 1.18 has NO native structured-output/schema API (declared in
 * RuntimeCapabilities.nativeStructuredOutput = false), so strategy tier 2/3
 * applies: an EXACT JSON final-response contract enforced by a STRICT parser
 * over the COMPLETE final output. Forbidden and therefore absent: regex
 * extraction from prose, partial-JSON salvage, best-effort field invention.
 *
 * A parse/validation failure is a RUNTIME FACT (the Worker produced no usable
 * Report) — the caller maps it to an indeterminate Attempt (§37). It is never
 * converted into a fabricated `result: "failed"` Report.
 *
 * IDENTITY FIELDS ARE NOT TRUSTED (§42/§43/§87): `directive`, `workerRole`,
 * and `baseCandidateRevision` are shape-validated but the host ALWAYS
 * overwrites them from the durable Attempt before submission.
 */
import { UltraPlanError } from "../core/errors.js";
import { assertExecutionReportResult } from "../core/execution-report.js";
import { EXECUTION_BLOCKER_KINDS } from "../core/execution-report.js";
import { WORKER_ROLES } from "../core/execution-attempt.js";
import { CANDIDATE_MUTATIONS } from "../core/execution-report.js";
import { CONFLICT_RESOLUTION_OUTCOMES } from "../core/verification-conflict.js";
import { RECONCILIATION_OBSERVATIONS } from "../core/attempt-reconciliation.js";
import type { WorkerReportPayload } from "../worker/report-payload.js";

/** Top-level keys of the exact final-response contract. */
const PAYLOAD_KEYS = new Set([
  "directive",
  "workerRole",
  "result",
  "actionsPerformed",
  "filesExamined",
  "filesChanged",
  "commandsRun",
  "testsRun",
  "findings",
  "deviations",
  "blockers",
  "deliverables",
  "candidateMutation",
  "baseCandidateRevision",
  "conflictResolutionOutcome",
  "reconciliationObservation",
]);

const STRING_ARRAY_KEYS = [
  "actionsPerformed",
  "filesExamined",
  "filesChanged",
  "commandsRun",
  "testsRun",
  "deliverables",
] as const;

function fail(reason: string): never {
  throw new UltraPlanError("worker_output_invalid", reason, {});
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    fail(`"${field}" must be an array of strings`);
  }
}

/**
 * Deterministic fence strip: when the ENTIRE output is one markdown code
 * fence, parse its content. This is complete-output normalization, not
 * salvage — anything else (prose around JSON, trailing text, two objects)
 * fails.
 */
function stripSingleFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[a-zA-Z0-9]*\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
  return match ? match[1]! : trimmed;
}

/**
 * Parse the Worker's COMPLETE final output into a WorkerReportPayload.
 * Throws `worker_output_invalid` on any deviation from the contract.
 */
export function parseWorkerReportOutput(raw: string): WorkerReportPayload {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    fail("the Worker produced no final output");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripSingleFence(raw));
  } catch {
    fail("the final output is not a single complete JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("the final output must be a JSON object");
  }
  const payload = parsed as Record<string, unknown>;
  for (const key of Object.keys(payload)) {
    if (!PAYLOAD_KEYS.has(key)) fail(`unknown field "${key}" is not part of the Worker report contract`);
  }

  // Identity fields — shape-checked, then OVERWRITTEN by the host (§42/§43).
  const directive = payload["directive"];
  if (
    typeof directive !== "object" ||
    directive === null ||
    typeof (directive as Record<string, unknown>)["id"] !== "string" ||
    typeof (directive as Record<string, unknown>)["revision"] !== "number" ||
    typeof (directive as Record<string, unknown>)["hash"] !== "string"
  ) {
    fail('"directive" must be {id, revision, hash}');
  }
  if (!(WORKER_ROLES as readonly string[]).includes(payload["workerRole"] as string)) {
    fail(`"workerRole" must be one of ${WORKER_ROLES.join("|")}`);
  }
  assertExecutionReportResult(payload["result"] as string);
  if (!(CANDIDATE_MUTATIONS as readonly string[]).includes(payload["candidateMutation"] as string)) {
    fail(`"candidateMutation" must be one of ${CANDIDATE_MUTATIONS.join("|")}`);
  }
  if (typeof payload["baseCandidateRevision"] !== "number" || !Number.isInteger(payload["baseCandidateRevision"])) {
    fail('"baseCandidateRevision" must be an integer');
  }
  for (const field of STRING_ARRAY_KEYS) assertStringArray(payload[field], field);

  // findings: legacy plain strings OR explicitly classified objects.
  if (!Array.isArray(payload["findings"])) fail('"findings" must be an array');
  for (const finding of payload["findings"] as unknown[]) {
    if (typeof finding === "string") continue;
    if (
      typeof finding !== "object" ||
      finding === null ||
      typeof (finding as Record<string, unknown>)["statement"] !== "string" ||
      !["informational", "blocking"].includes((finding as Record<string, unknown>)["acceptanceImpact"] as string)
    ) {
      fail('every finding must be a string or {statement, acceptanceImpact: "informational"|"blocking"}');
    }
  }

  // deviations: closed vocabulary.
  if (!Array.isArray(payload["deviations"])) fail('"deviations" must be an array');
  for (const deviation of payload["deviations"] as unknown[]) {
    if (
      typeof deviation !== "object" ||
      deviation === null ||
      !["path", "symbol", "additional_requirement", "other"].includes((deviation as Record<string, unknown>)["kind"] as string) ||
      typeof (deviation as Record<string, unknown>)["note"] !== "string" ||
      ((deviation as Record<string, unknown>)["note"] as string).length === 0
    ) {
      fail('every deviation must be {kind: "path"|"symbol"|"additional_requirement"|"other", note, expected?, actual?}');
    }
  }

  // blockers: closed kind vocabulary + non-empty summary.
  if (!Array.isArray(payload["blockers"])) fail('"blockers" must be an array');
  for (const blocker of payload["blockers"] as unknown[]) {
    if (
      typeof blocker !== "object" ||
      blocker === null ||
      !(EXECUTION_BLOCKER_KINDS as readonly string[]).includes((blocker as Record<string, unknown>)["kind"] as string) ||
      typeof (blocker as Record<string, unknown>)["summary"] !== "string" ||
      ((blocker as Record<string, unknown>)["summary"] as string).length === 0
    ) {
      fail("every blocker must be {kind: <closed vocabulary>, summary, detail?, needed?}");
    }
  }

  // Phase 6A extensions: only the exact vocabularies, presence-validated
  // here; whether they are LEGAL for this Directive is Core's submission gate.
  if (payload["conflictResolutionOutcome"] !== undefined) {
    if (!(CONFLICT_RESOLUTION_OUTCOMES as readonly string[]).includes(payload["conflictResolutionOutcome"] as string)) {
      fail(`"conflictResolutionOutcome" must be one of ${CONFLICT_RESOLUTION_OUTCOMES.join("|")}`);
    }
  }
  if (payload["reconciliationObservation"] !== undefined) {
    if (!(RECONCILIATION_OBSERVATIONS as readonly string[]).includes(payload["reconciliationObservation"] as string)) {
      fail(`"reconciliationObservation" must be one of ${RECONCILIATION_OBSERVATIONS.join("|")}`);
    }
  }

  // Phase 4 semantic consistency, mirrored BEFORE submission so an
  // inconsistent payload is indeterminate output — never a guessed report.
  const result = payload["result"] as string;
  const blockers = payload["blockers"] as unknown[];
  if (result === "blocked" && blockers.length === 0) fail("a blocked report requires at least one structured blocker");
  if (result !== "blocked" && blockers.length > 0) fail("only a blocked report may carry blockers");

  return {
    directive: payload["directive"] as WorkerReportPayload["directive"],
    workerRole: payload["workerRole"] as WorkerReportPayload["workerRole"],
    result: result as WorkerReportPayload["result"],
    ...(payload["conflictResolutionOutcome"] !== undefined
      ? { conflictResolutionOutcome: payload["conflictResolutionOutcome"] as WorkerReportPayload["conflictResolutionOutcome"] }
      : {}),
    ...(payload["reconciliationObservation"] !== undefined
      ? { reconciliationObservation: payload["reconciliationObservation"] as WorkerReportPayload["reconciliationObservation"] }
      : {}),
    actionsPerformed: [...(payload["actionsPerformed"] as string[])],
    filesExamined: [...(payload["filesExamined"] as string[])],
    filesChanged: [...(payload["filesChanged"] as string[])],
    commandsRun: [...(payload["commandsRun"] as string[])],
    testsRun: [...(payload["testsRun"] as string[])],
    findings: payload["findings"] as WorkerReportPayload["findings"],
    deviations: payload["deviations"] as WorkerReportPayload["deviations"],
    blockers: payload["blockers"] as WorkerReportPayload["blockers"],
    deliverables: [...(payload["deliverables"] as string[])],
    candidateMutation: payload["candidateMutation"] as WorkerReportPayload["candidateMutation"],
    baseCandidateRevision: payload["baseCandidateRevision"] as number,
  };
}
