/**
 * ExecutionDirective domain shape (v0.2.0 architecture spec §45–§50, E4 §4–§15).
 *
 * PURE core: vocabulary, canonical shape, canonical hash, row validation.
 * No SQLite, no host, no MCP.
 *
 * An ExecutionDirective is ONE logical work item under an active ExecutionRun.
 * Its identity is (directiveId, revision) — immutable EXACT instruction
 * identity (E4 §8): revision 1 is issued first and later revisions are new
 * rows, never in-place edits (E4 §11). Every revision binds the exact run /
 * FinalPlan / Stage / Window / candidateRevision authority context at issuance
 * (E4 §6) and is deterministically hash-addressable over its canonical
 * content (E4 §10).
 *
 * E4 has NO ExecutionCommit: the only legal accepted base is `execution_start`,
 * resolving exactly to the bound ExecutionRun's persisted executionStartBaseline
 * (E4 §5). `execution_commit` exists as future-compatible vocabulary only.
 *
 * Kinds beyond implementation/inspection/verification (recovery, rework,
 * diagnostic, conflict_resolution) are USES of these kinds, never new kinds
 * (E4 §7).
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";
import type { ExecutionScopeKind } from "./verification-window.js";
import { isExecutionScopeKind } from "./verification-window.js";
import { RuntimeError } from "../runtime/errors.js";

export const EXECUTION_DIRECTIVE_KINDS = ["implementation", "inspection", "verification"] as const;

export type ExecutionDirectiveKind = (typeof EXECUTION_DIRECTIVE_KINDS)[number];

export function isExecutionDirectiveKind(value: string): value is ExecutionDirectiveKind {
  return (EXECUTION_DIRECTIVE_KINDS as readonly string[]).includes(value);
}

export const ACCEPTED_BASE_KINDS = ["execution_start", "execution_commit"] as const;

export type AcceptedBaseKind = (typeof ACCEPTED_BASE_KINDS)[number];

/**
 * The exact accepted base a Directive is issued against (E4 §5). In E4 only
 * `execution_start` is legal and baselineRef must equal the bound ExecutionRun's
 * persisted executionStartBaseline. `execution_commit` is reserved vocabulary —
 * E5/E6 bind real commits WITHOUT rewriting historical E4 Directive meaning.
 */
export type AcceptedExecutionBase =
  | { kind: "execution_start"; baseline: Record<string, unknown> }
  | { kind: "execution_commit"; executionCommitId: string };

/** One exact approved plan reference (the SynthesisBundleRef shape, E4 §12). */
export interface DirectivePlanRef {
  kind: string;
  id: string;
  revision: number;
}

/**
 * Coarse, role-independent capability envelope (E4 §14) — the SAME schema for
 * every Directive kind. Explicit and complete by construction: parse rejects
 * missing/non-boolean fields, so persisted content never depends on hidden
 * kind-based defaults (E4 §15). This is NOT a path allowlist and NOT a host
 * permission boundary (E4 §13) — the runtime intersection with the host/User
 * ceiling belongs to the Worker runtime phase.
 */
export interface ExecutionCapabilityEnvelope {
  repositoryRead: boolean;
  repositoryWrite: boolean;
  commandExecution: boolean;
  networkAccess: boolean;
  dependencyMutation: boolean;
  gitCommit: boolean;
  gitPush: boolean;
  externalServiceMutation: boolean;
}

export const CAPABILITY_ENVELOPE_FIELDS = [
  "repositoryRead",
  "repositoryWrite",
  "commandExecution",
  "networkAccess",
  "dependencyMutation",
  "gitCommit",
  "gitPush",
  "externalServiceMutation",
] as const;

export function parseCapabilityEnvelope(raw: unknown): ExecutionCapabilityEnvelope {
  if (typeof raw !== "object" || raw === null) {
    throw envelopeError("capability envelope is not an object");
  }
  const problems = CAPABILITY_ENVELOPE_FIELDS.filter(
    (field) => typeof (raw as Record<string, unknown>)[field] !== "boolean",
  );
  if (problems.length > 0) {
    throw envelopeError(`missing or non-boolean capability fields: ${problems.join(", ")}`);
  }
  const extra = Object.keys(raw).filter((key) => !(CAPABILITY_ENVELOPE_FIELDS as readonly string[]).includes(key));
  if (extra.length > 0) {
    throw envelopeError(`unknown capability fields: ${extra.join(", ")}`);
  }
  return raw as ExecutionCapabilityEnvelope;
}

function envelopeError(message: string): RuntimeError {
  return new RuntimeError("CAPABILITY_ENVELOPE_INVALID", message, { recoverable: false });
}

/**
 * The smallest structured report contract (E4 §34): which report sections the
 * Worker MUST populate. Report submission validates these deterministically.
 */
export interface DirectiveReportContract {
  requireActionsPerformed: boolean;
  requireFilesExamined: boolean;
  requireFilesChanged: boolean;
  requireCommandsRun: boolean;
  requireTestsRun: boolean;
  requireFindings: boolean;
  requireDeviations: boolean;
  requireBlockers: boolean;
  requireDeliverables: boolean;
}

export const REPORT_CONTRACT_FIELDS = [
  "requireActionsPerformed",
  "requireFilesExamined",
  "requireFilesChanged",
  "requireCommandsRun",
  "requireTestsRun",
  "requireFindings",
  "requireDeviations",
  "requireBlockers",
  "requireDeliverables",
] as const;

export function parseReportContract(raw: unknown): DirectiveReportContract {
  if (typeof raw !== "object" || raw === null) {
    throw new RuntimeError("REPORT_CONTRACT_VIOLATION", "report contract is not an object", { recoverable: false });
  }
  const problems = REPORT_CONTRACT_FIELDS.filter(
    (field) => typeof (raw as Record<string, unknown>)[field] !== "boolean",
  );
  if (problems.length > 0) {
    throw new RuntimeError(
      "REPORT_CONTRACT_VIOLATION",
      `report contract has missing or non-boolean fields: ${problems.join(", ")}`,
      { recoverable: false },
    );
  }
  return raw as DirectiveReportContract;
}

/**
 * Expected execution scope — GUIDANCE ONLY (E4 §13). No Phase Plan path
 * enforcement, symbol allowlist, or PreToolUse rejection is derived from it;
 * Workers may deviate when semantics are preserved and report the deviation.
 */
export interface ExpectedExecutionScope {
  files: string[];
  symbols: string[];
  callPaths: string[];
  tests: string[];
}

/** Structured Directive content items (E4 §4, simplified repository-native shapes). */
export interface DirectiveInvariant {
  statement: string;
}

export interface ActionRequirement {
  action: string;
  detail: string | null;
}

export interface ActionProhibition {
  action: string;
  detail: string | null;
}

export interface ValidationRequirement {
  requirement: string;
  detail: string | null;
}

export interface DeliverableRequirement {
  name: string;
  detail: string | null;
}

export interface StopCondition {
  condition: string;
  detail: string | null;
}

/**
 * E8 §4 — Directive protocol/hash version. v1 = the EXACT pre-E8 canonical
 * payload (frozen forever; historical rows are never re-hashed). v2 = the E8
 * canonical payload, which additionally binds the structured verification
 * policy. E10 §15/§16 — v3 = the scope-aware canonical payload: every
 * Directive carries its EXACT execution scope as explicit canonical content
 * (never a merely-omitted stageId). Every newly issued Directive is v3
 * (E10 §17); v1/v2 hashes are frozen history.
 */
export const DIRECTIVE_PROTOCOL_VERSIONS = [1, 2, 3, 4] as const;

export type DirectiveProtocolVersion = (typeof DIRECTIVE_PROTOCOL_VERSIONS)[number];

/** E8 §6 — immutable structured verification semantics (v2 only). */
export interface DirectiveVerificationPolicy {
  /** implementation kind only: batchable | immediate. */
  implementationRequirement?: "batchable" | "immediate";
  /** verification kind only: normal | conflict_resolution. */
  verificationPurpose?: "normal" | "conflict_resolution";
  /** verification kind, purpose=conflict_resolution only: the exact conflict. */
  verificationConflictId?: string;
}

export interface ExecutionDirective {
  directiveId: string;
  revision: number;
  /** Deterministic content hash over everything below EXCEPT issuedAt (E4 §10). */
  hash: string;
  /**
   * E8 §4 — the protocol/hash version this revision was hashed under. v1 rows
   * keep their exact pre-E8 hashes forever; v4 binds the A1 identity model.
   * All NEW rows are v4 (A1 §20); v1/v2/v3 hashes are frozen history.
   */
  protocolVersion: DirectiveProtocolVersion;
  /**
   * A1 §13/§16 — the exact ExecutionRunID this Directive executes under.
   * Canonical execution authority scope (execution_runs.execution_run_id).
   */
  executionRunId: string;
  /**
   * A1 §16 — the source PlanningRunID provenance (execution_runs.run_id).
   * Historical v1/v2/v3 rows carry the original hashed value byte-stable;
   * v4 rows carry it explicitly in the canonical payload as provenance.
   */
  runId: string;
  /** The EXACT FinalPlan permanently bound to that ExecutionRun. */
  finalPlanRef: { id: string; revision: number; hash: string };
  /**
   * E10 §5/§16 — the explicit execution scope. `stage` binds the exact
   * ExecutionStage; `final_closure` is run-level and carries null. Historical
   * v1/v2 rows are stage-scoped compatibility metadata and never re-hashed.
   */
  scopeKind: ExecutionScopeKind;
  /** The stage-scoped ExecutionStage, or null for final closure. */
  stageId: string | null;
  windowId: string;
  kind: ExecutionDirectiveKind;
  /** The Window candidateRevision the Directive was issued against. */
  baseCandidateRevision: number;
  acceptedBase: AcceptedExecutionBase;
  /**
   * E8 §6 — structured verification policy. Null for v1 (historical policy is
   * explicitly unknown, never backfilled) and for v2 inspection (all policy
   * fields null by frozen legality).
   */
  verificationPolicy: DirectiveVerificationPolicy | null;
  objective: string;
  planRefs: DirectivePlanRef[];
  expectedExecutionScope: ExpectedExecutionScope;
  capabilityEnvelope: ExecutionCapabilityEnvelope;
  invariants: DirectiveInvariant[];
  requiredActions: ActionRequirement[];
  forbiddenActions: ActionProhibition[];
  validationRequirements: ValidationRequirement[];
  deliverables: DeliverableRequirement[];
  stopConditions: StopCondition[];
  reportContract: DirectiveReportContract;
  /** Detailed Worker instruction — never the machine-checkable authority itself (E4 §35). */
  body: string;
  issuedAt: string;
}

/**
 * E8 §4/§5 — protocol-dispatched canonical content. v1 produces the EXACT
 * historical pre-E8 payload (byte-identical to the E4–E7 algorithm — historical
 * hashes are never reinterpreted); v2 additionally binds the protocol version
 * and the structured verification policy. Hash input excludes issuedAt in both
 * versions (E4 §10).
 */
export function canonicalDirectiveV1(directive: Omit<ExecutionDirective, "hash" | "issuedAt">): string {
  return canonicalJson({
    directiveId: directive.directiveId,
    revision: directive.revision,
    runId: directive.runId,
    finalPlanRef: directive.finalPlanRef,
    stageId: directive.stageId,
    windowId: directive.windowId,
    kind: directive.kind,
    baseCandidateRevision: directive.baseCandidateRevision,
    acceptedBase: directive.acceptedBase,
    objective: directive.objective,
    planRefs: directive.planRefs,
    expectedExecutionScope: directive.expectedExecutionScope,
    capabilityEnvelope: directive.capabilityEnvelope,
    invariants: directive.invariants,
    requiredActions: directive.requiredActions,
    forbiddenActions: directive.forbiddenActions,
    validationRequirements: directive.validationRequirements,
    deliverables: directive.deliverables,
    stopConditions: directive.stopConditions,
    reportContract: directive.reportContract,
    body: directive.body,
  });
}

/**
 * E8 §5 — the frozen v2 canonical payload (exported for the
 * frozen-canonicalizer compatibility pins; production code hashes through
 * executionDirectiveContent/executionDirectiveHash only).
 */
export function canonicalDirectiveV2(directive: Omit<ExecutionDirective, "hash" | "issuedAt">): string {
  return canonicalJson({
    directiveId: directive.directiveId,
    revision: directive.revision,
    runId: directive.runId,
    finalPlanRef: directive.finalPlanRef,
    stageId: directive.stageId,
    windowId: directive.windowId,
    kind: directive.kind,
    baseCandidateRevision: directive.baseCandidateRevision,
    acceptedBase: directive.acceptedBase,
    protocolVersion: 2,
    verificationPolicy: directive.verificationPolicy ?? null,
    objective: directive.objective,
    planRefs: directive.planRefs,
    expectedExecutionScope: directive.expectedExecutionScope,
    capabilityEnvelope: directive.capabilityEnvelope,
    invariants: directive.invariants,
    requiredActions: directive.requiredActions,
    forbiddenActions: directive.forbiddenActions,
    validationRequirements: directive.validationRequirements,
    deliverables: directive.deliverables,
    stopConditions: directive.stopConditions,
    reportContract: directive.reportContract,
    body: directive.body,
  });
}

/**
 * E10 §16 — the v3 canonical payload. The execution scope is EXPLICIT
 * canonical content ({kind: "stage", stageId} | {kind: "final_closure"}), not
 * an omitted stageId; the structured verification policy (frozen E8 legality
 * matrix) is carried forward from v2. v1/v2 payloads are never reinterpreted.
 */
export function canonicalDirectiveV3(directive: Omit<ExecutionDirective, "hash" | "issuedAt">): string {
  return canonicalJson({
    directiveId: directive.directiveId,
    revision: directive.revision,
    runId: directive.runId,
    finalPlanRef: directive.finalPlanRef,
    scope: directive.scopeKind === "stage"
      ? { kind: "stage", stageId: directive.stageId }
      : { kind: "final_closure" },
    windowId: directive.windowId,
    kind: directive.kind,
    baseCandidateRevision: directive.baseCandidateRevision,
    acceptedBase: directive.acceptedBase,
    protocolVersion: 3,
    verificationPolicy: directive.verificationPolicy ?? null,
    objective: directive.objective,
    planRefs: directive.planRefs,
    expectedExecutionScope: directive.expectedExecutionScope,
    capabilityEnvelope: directive.capabilityEnvelope,
    invariants: directive.invariants,
    requiredActions: directive.requiredActions,
    forbiddenActions: directive.forbiddenActions,
    validationRequirements: directive.validationRequirements,
    deliverables: directive.deliverables,
    stopConditions: directive.stopConditions,
    reportContract: directive.reportContract,
    body: directive.body,
  });
}

/**
 * A1 §13.1 — the v4 canonical payload: every Directive binds BOTH the exact
 * ExecutionRunID (authority) and the sourcePlanningRunId (immutable
 * provenance) as explicit canonical content. No ambiguous `runId` key exists
 * in a v4 payload. The v3 field set carries forward unchanged otherwise.
 * v1/v2/v3 payloads are never reinterpreted.
 */
export function canonicalDirectiveV4(directive: Omit<ExecutionDirective, "hash" | "issuedAt">): string {
  return canonicalJson({
    directiveId: directive.directiveId,
    revision: directive.revision,
    executionRunId: directive.executionRunId,
    sourcePlanningRunId: directive.runId,
    finalPlanRef: directive.finalPlanRef,
    scope: directive.scopeKind === "stage"
      ? { kind: "stage", stageId: directive.stageId }
      : { kind: "final_closure" },
    windowId: directive.windowId,
    kind: directive.kind,
    baseCandidateRevision: directive.baseCandidateRevision,
    acceptedBase: directive.acceptedBase,
    protocolVersion: 4,
    verificationPolicy: directive.verificationPolicy ?? null,
    objective: directive.objective,
    planRefs: directive.planRefs,
    expectedExecutionScope: directive.expectedExecutionScope,
    capabilityEnvelope: directive.capabilityEnvelope,
    invariants: directive.invariants,
    requiredActions: directive.requiredActions,
    forbiddenActions: directive.forbiddenActions,
    validationRequirements: directive.validationRequirements,
    deliverables: directive.deliverables,
    stopConditions: directive.stopConditions,
    reportContract: directive.reportContract,
    body: directive.body,
  });
}

export function executionDirectiveContent(directive: Omit<ExecutionDirective, "hash" | "issuedAt">): string {
  if (directive.protocolVersion === 4) return canonicalDirectiveV4(directive);
  if (directive.protocolVersion === 3) return canonicalDirectiveV3(directive);
  return directive.protocolVersion === 2 ? canonicalDirectiveV2(directive) : canonicalDirectiveV1(directive);
}

export function executionDirectiveHash(directive: Omit<ExecutionDirective, "hash" | "issuedAt">): string {
  return `sha256:${createHash("sha256").update(executionDirectiveContent(directive), "utf8").digest("hex")}`;
}

function stringifyListField(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? "null";
  } catch {
    return "null";
  }
}

/**
 * E8 §6 — the frozen policy-legality matrix. Structural, checked at parse
 * (store corruption) and at issuance (typed refusal):
 *   implementation → implementationRequirement required; purpose/conflict null
 *   verification    → implementationRequirement null; purpose required;
 *                     conflict_resolution → conflictId required; normal → null
 *   inspection      → all policy fields null (policy object absent)
 */
export function validateDirectivePolicyLegality(
  kind: ExecutionDirectiveKind,
  policy: DirectiveVerificationPolicy | null,
): string[] {
  const problems: string[] = [];
  if (kind === "implementation") {
    if (policy === null || (policy.implementationRequirement !== "batchable" && policy.implementationRequirement !== "immediate")) {
      problems.push("verificationPolicy.implementationRequirement");
    }
    if (policy !== null && policy.verificationPurpose !== undefined) problems.push("verificationPolicy.verificationPurpose");
    if (policy !== null && policy.verificationConflictId !== undefined) problems.push("verificationPolicy.verificationConflictId");
  } else if (kind === "verification") {
    if (policy === null || (policy.verificationPurpose !== "normal" && policy.verificationPurpose !== "conflict_resolution")) {
      problems.push("verificationPolicy.verificationPurpose");
    }
    if (policy !== null && policy.implementationRequirement !== undefined) problems.push("verificationPolicy.implementationRequirement");
    if (policy !== null && policy.verificationPurpose === "conflict_resolution" && (typeof policy.verificationConflictId !== "string" || policy.verificationConflictId === "")) {
      problems.push("verificationPolicy.verificationConflictId");
    }
    if (policy !== null && policy.verificationPurpose === "normal" && policy.verificationConflictId !== undefined) {
      problems.push("verificationPolicy.verificationConflictId");
    }
  } else {
    if (policy !== null) problems.push("verificationPolicy");
  }
  return problems;
}

/** Parse the persisted policy columns (E8 §5/§46 — v1 policy stays NULL). */
function parseVerificationPolicy(
  kind: ExecutionDirectiveKind,
  protocolVersion: number,
  requirement: unknown,
  purpose: unknown,
  conflictId: unknown,
): DirectiveVerificationPolicy | null {
  if (protocolVersion === 1) {
    if (requirement !== null || purpose !== null || conflictId !== null) {
      throw new RuntimeError("STORE_SCHEMA_INVALID", "a v1 directive must carry no verification policy", {
        detail: { fields: ["verification_policy"] },
      });
    }
    return null;
  }
  if (requirement === null && purpose === null && conflictId === null) {
    if (kind !== "inspection") {
      throw new RuntimeError("STORE_SCHEMA_INVALID", "a v2/v3/v4 non-inspection directive is missing its verification policy", {
        detail: { fields: ["verification_policy"] },
      });
    }
    return null;
  }
  const policy: DirectiveVerificationPolicy = {};
  if (requirement !== null) {
    if (requirement !== "batchable" && requirement !== "immediate") {
      throw new RuntimeError("STORE_SCHEMA_INVALID", "verification_requirement vocabulary is corrupt", {
        detail: { fields: ["verification_requirement"] },
      });
    }
    policy.implementationRequirement = requirement;
  }
  if (purpose !== null) {
    if (purpose !== "normal" && purpose !== "conflict_resolution") {
      throw new RuntimeError("STORE_SCHEMA_INVALID", "verification_purpose vocabulary is corrupt", {
        detail: { fields: ["verification_purpose"] },
      });
    }
    policy.verificationPurpose = purpose;
  }
  if (conflictId !== null) {
    if (typeof conflictId !== "string" || conflictId === "") {
      throw new RuntimeError("STORE_SCHEMA_INVALID", "verification_conflict_id is corrupt", {
        detail: { fields: ["verification_conflict_id"] },
      });
    }
    policy.verificationConflictId = conflictId;
  }
  return policy;
}

/**
 * Validate a raw database row into an ExecutionDirective. Illegal vocabulary,
 * non-positive revision, a broken accepted-base/envelope/contract shape, or
 * unparsable JSON columns is store corruption — surfaced as STORE_SCHEMA_INVALID
 * (envelope/contract violations keep their dedicated codes).
 */
export function parseExecutionDirectiveRow(row: Record<string, unknown>): ExecutionDirective {
  const problems: string[] = [];
  if (typeof row.directiveId !== "string" || row.directiveId === "") problems.push("directive_id");
  if (typeof row.revision !== "number" || !Number.isInteger(row.revision) || row.revision < 1) problems.push("revision");
  if (typeof row.hash !== "string" || row.hash === "") problems.push("hash");
  // E8 §5 — pre-migration rows carry no protocol_version column value; they
  // are v1 by definition and are never re-hashed. E10 §17 — post-v23 rows are
  // v3 with explicit scope.
  const protocolVersion = typeof row.protocolVersion === "number" ? row.protocolVersion : 1;
  if (protocolVersion !== 1 && protocolVersion !== 2 && protocolVersion !== 3 && protocolVersion !== 4) problems.push("protocol_version");
  // A1 §16 — every row carries its exact-run linkage; the legacy run_id
  // remains the (provenance-only) PlanningRunID.
  if (typeof row.executionRunId !== "string" || row.executionRunId === "") problems.push("execution_run_id");
  if (typeof row.runId !== "string" || row.runId === "") problems.push("run_id");
  if (typeof row.finalPlanRef !== "object" || row.finalPlanRef === null) {
    problems.push("final_plan_ref");
  } else {
    const ref = row.finalPlanRef as Record<string, unknown>;
    if (typeof ref.id !== "string" || ref.id === "") problems.push("final_plan_ref.id");
    if (typeof ref.revision !== "number" || !Number.isInteger(ref.revision) || ref.revision < 1) {
      problems.push("final_plan_ref.revision");
    }
    if (typeof ref.hash !== "string" || ref.hash === "") problems.push("final_plan_ref.hash");
  }
  // E10 §5/§6 — the scope shape is re-derived at parse (the DDL trigger is
  // the first fence): stage ↔ non-null stage id, final_closure ↔ null.
  if (typeof row.scopeKind !== "string" || !isExecutionScopeKind(row.scopeKind)) problems.push("scope_kind");
  if (row.stageId !== null && typeof row.stageId !== "string") problems.push("stage_id");
  if (typeof row.stageId === "string" && row.stageId === "") problems.push("stage_id");
  if (typeof row.scopeKind === "string" && isExecutionScopeKind(row.scopeKind)) {
    if (row.scopeKind === "stage" && typeof row.stageId !== "string") problems.push("scope_shape");
    if (row.scopeKind === "final_closure" && row.stageId !== null) problems.push("scope_shape");
  }
  if (typeof row.windowId !== "string" || row.windowId === "") problems.push("window_id");
  if (typeof row.kind !== "string" || !isExecutionDirectiveKind(row.kind)) problems.push("kind");
  if (
    typeof row.baseCandidateRevision !== "number"
    || !Number.isInteger(row.baseCandidateRevision)
    || row.baseCandidateRevision < 0
  ) {
    problems.push("base_candidate_revision");
  }
  if (typeof row.acceptedBase !== "object" || row.acceptedBase === null) {
    problems.push("accepted_base");
  } else {
    const base = row.acceptedBase as Record<string, unknown>;
    if (base.kind === "execution_start") {
      if (typeof base.baseline !== "object" || base.baseline === null) problems.push("accepted_base.baseline");
    } else if (base.kind === "execution_commit") {
      if (typeof base.executionCommitId !== "string" || base.executionCommitId === "") {
        problems.push("accepted_base.executionCommitId");
      }
    } else {
      problems.push("accepted_base.kind");
    }
  }
  if (typeof row.objective !== "string" || row.objective === "") problems.push("objective");
  for (const field of [
    "planRefs",
    "invariants",
    "requiredActions",
    "forbiddenActions",
    "validationRequirements",
    "deliverables",
    "stopConditions",
  ] as const) {
    if (!Array.isArray(row[field])) problems.push(field);
  }
  if (typeof row.expectedExecutionScope !== "object" || row.expectedExecutionScope === null) {
    problems.push("expected_execution_scope");
  } else {
    const scope = row.expectedExecutionScope as Record<string, unknown>;
    for (const field of ["files", "symbols", "callPaths", "tests"] as const) {
      if (!Array.isArray(scope[field]) || (scope[field] as unknown[]).some((entry) => typeof entry !== "string")) {
        problems.push(`expected_execution_scope.${field}`);
      }
    }
  }
  if (typeof row.body !== "string") problems.push("body");
  if (typeof row.issuedAt !== "string" || row.issuedAt === "") problems.push("issued_at");
  if (problems.length > 0) {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "execution_directives row is corrupt", {
      detail: { fields: problems },
    });
  }
  const verificationPolicy = parseVerificationPolicy(
    row.kind as ExecutionDirectiveKind,
    protocolVersion,
    row.verificationRequirement ?? null,
    row.verificationPurpose ?? null,
    row.verificationConflictId ?? null,
  );
  // E8 §6 — the kind-legality matrix governs v2+ rows only; a v1 row's policy
  // is NULL by definition and its frozen interpretation is never re-judged.
  const legalityProblems =
    protocolVersion >= 2
      ? validateDirectivePolicyLegality(row.kind as ExecutionDirectiveKind, verificationPolicy)
      : [];
  if (legalityProblems.length > 0) {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "execution_directives row violates the verification-policy legality matrix", {
      detail: { fields: legalityProblems },
    });
  }
  return {
    directiveId: row.directiveId as string,
    revision: row.revision as number,
    hash: row.hash as string,
    protocolVersion: protocolVersion as DirectiveProtocolVersion,
    executionRunId: row.executionRunId as string,
    runId: row.runId as string,
    finalPlanRef: row.finalPlanRef as ExecutionDirective["finalPlanRef"],
    scopeKind: row.scopeKind as ExecutionScopeKind,
    stageId: (row.stageId as string | null) ?? null,
    windowId: row.windowId as string,
    kind: row.kind as ExecutionDirectiveKind,
    baseCandidateRevision: row.baseCandidateRevision as number,
    acceptedBase: row.acceptedBase as AcceptedExecutionBase,
    verificationPolicy,
    objective: row.objective as string,
    planRefs: row.planRefs as DirectivePlanRef[],
    expectedExecutionScope: row.expectedExecutionScope as ExpectedExecutionScope,
    capabilityEnvelope: parseCapabilityEnvelope(row.capabilityEnvelope),
    invariants: row.invariants as DirectiveInvariant[],
    requiredActions: row.requiredActions as ActionRequirement[],
    forbiddenActions: row.forbiddenActions as ActionProhibition[],
    validationRequirements: row.validationRequirements as ValidationRequirement[],
    deliverables: row.deliverables as DeliverableRequirement[],
    stopConditions: row.stopConditions as StopCondition[],
    reportContract: parseReportContract(row.reportContract),
    body: row.body as string,
    issuedAt: row.issuedAt as string,
  };
}

/** Stable canonical form of a plan ref list for hashing/storage. */
export function planRefsJson(refs: DirectivePlanRef[]): string {
  return stringifyListField(refs);
}
