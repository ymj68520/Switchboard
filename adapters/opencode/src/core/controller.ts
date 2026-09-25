/**
 * Ultra Plan Controller — spec §3 (entry point flow) + Phase 2A tool
 * authorization boundary.
 *
 * Owns the /ultra-plan → PlanningRun lifecycle and is the single enforcement
 * point for planning-model operations: every model-facing operation resolves
 * its run through authorizeTool (capability matrix in core/capabilities.ts)
 * before touching state. The controller orchestrates; the state machine,
 * invariants, and store enforce.
 *
 * Authority boundary (Phase 2A): nothing in this file — and nothing callable
 * by the planning model — mutates committed Plan Memory or creates an
 * Approval/PlanCommit. Committed memory advances only via
 * PlanStore.commitTransaction (Phase 2B engine).
 */
import {
  ApprovalIDs,
  ConflictIDs,
  CommitIDs,
  DecisionIDs,
  EvidenceIDs,
  FinalPlanIDs,
  nextSequence,
  PlanIDs,
  ProposalIDs,
  QuestionIDs,
  SectionIDs,
  SnapshotIDs,
  ConstraintIDs,
  SynthesisInputIDs,
  SynthesisManifestIDs,
  EvidenceAuditIDs,
  FinalPlanCandidateIDs,
  HandoffIDs,
  ValidationFindingIDs,
  ValidationReportIDs,
} from "./ids.js";
import type { DecisionID, PlanID, QuestionID, SectionID } from "./ids.js";
import { assertCapability, requireRun, type CapabilityContext, type UltraPlanCapability } from "./capabilities.js";
import { InMemoryStartAdmissionLedger, type StartAdmission, type StartAdmissionLedger } from "./admissions.js";
import {
  assembleFinalPlanCandidate,
  renderFinalPlanCandidatePreview,
} from "../finalization/candidate.js";
import { buildFinalPlanFromCandidate, finalizationIdentityMatchesCandidate } from "../finalization/plan.js";
import {
  buildEvidenceAudit,
  computeCurrentEvidenceStateHash,
} from "../finalization/audit.js";
import { evaluateFinalizationGate, type FinalizationGateDeps, type ResolvedGateSection } from "../finalization/gate.js";
import type {
  EvidenceAuditIdentity,
  EvidenceAuditSnapshot,
  FinalizationGateResult,
  FinalPlanCandidate,
} from "../finalization/types.js";
import { transitionStage } from "./state-machine.js";
import type { DecisionRef, EvidenceRef, MemoryRef, SectionRef, SectionRevisionRef, Timestamp, WorkRef } from "./refs.js";
import { renderNoRunStatus, renderStatus, type StatusDetails } from "../memory/renderer.js";
import type { PlanStore } from "../memory/store.js";
import type {
  RuntimeActivationInput,
  RuntimeActivationResult,
  UltraPlanRuntime,
} from "../runtime/types.js";
import { TOOL_CONTRACTS } from "../tools/contracts.js";
import type { Observation, SourceLocator } from "../repository/observations.js";
import type { Evidence, EvidenceScope, EvidenceSource } from "../repository/evidence.js";
import type { ApprovalRequest, UserApprovalDecision, BegunApproval } from "../transaction/approval.js";
import { applyApprovalDecision } from "../transaction/approval.js";
import { renderProposalForApproval } from "../memory/approval-view.js";
import type {
  Approval,
  ApprovedArchitecture,
  ApprovedConstraint,
  ApprovedDecision,
  ApprovedSectionRevision,
  ApprovedSectionRoot,
  ArchitectureDraft,
  ConstraintDraft,
  PlanCommit,
  Proposal,
  ProposalChange,
  ReopenSectionReason,
  SectionDecompositionDraft,
  SectionRevisionDraft,
} from "../transaction/types.js";
import { computeProposalHash } from "../transaction/hash.js";
import { assertAcyclicSections, assertSectionCanComplete, stableStringify } from "./invariants.js";
import type { Snapshot } from "../memory/snapshots.js";
import { isUltraPlanError, UltraPlanError } from "./errors.js";
import { HandoffDispatchRejected } from "../runtime/types.js";
import type { HostDeliveryReceipt } from "../runtime/types.js";
import { assembleExecutionHandoff, renderExecutionHandoffPrompt } from "../handoff/assemble.js";
import type { ExecutionHandoff, HandoffDelivery } from "../handoff/types.js";
import type { HandoffID } from "./ids.js";
import {
  buildSynthesisAuthorityPayload,
  assertSynthesisEntryReady,
} from "../synthesis/entry.js";
import { validateManifestDraft } from "../synthesis/validate.js";
import { renderSynthesisCapsule } from "../synthesis/capsule.js";
import { SYNTHESIS_FINDING_CATEGORIES } from "../synthesis/types.js";
import type {
  SynthesisInput,
  SynthesisManifest,
  SynthesisSourceRef,
} from "../synthesis/types.js";
import { SEMANTIC_VALIDATION_PROTOCOL } from "../validation/protocol.js";
import { parseValidatorOutput } from "../validation/parse.js";
import { validateValidatorOutput } from "../validation/validate.js";
import { buildValidationCapsule } from "../validation/capsule.js";
import { computeValidationReportHash } from "../validation/hash.js";
import type {
  RawValidatorOutput,
  SemanticValidator,
  ValidationIdentity,
  ValidationReport,
} from "../validation/types.js";
import { validationIdentityKey } from "../validation/types.js";
import type {
  Architecture,
  Conflict,
  Decision,
  Dependency,
  FailureMode,
  FinalPlan,
  InterfaceRef,
  InterfaceSpec,
  OpenQuestion,
  PlanningRun,
  PlanningStage,
  Section,
  SectionRevision,
} from "./types.js";

// ---------------------------------------------------------------------------
// Model-facing input shapes (flattened for tool schemas; validated here)
// ---------------------------------------------------------------------------

/** Flattened MemoryRef as accepted from the model; combination-validated. */
export interface FlatMemoryRef {
  kind:
    | "architecture"
    | "section"
    | "decision"
    | "constraint"
    | "question"
    | "conflict"
    | "evidence"
    | "proposal"
    | "snapshot"
    | "commit"
    | "final_plan"
    | "synthesis_input"
    | "synthesis_manifest"
    | "validation_report"
    | "evidence_audit"
    | "final_plan_candidate"
    | "execution_handoff";
  id?: string;
  revision?: number;
}

export interface MemoryQuery {
  ref?: FlatMemoryRef;
  /** Read the dependency contracts of the given section (spec §20 example). */
  dependenciesOf?: string;
}

export interface MemoryReadResult {
  planID: PlanID;
  headSnapshot?: string;
  queried?: FlatMemoryRef;
  artifacts: {
    ref:
      | MemoryRef
      | { kind: "run" }
      | { kind: "synthesis_input"; id: string }
      | { kind: "synthesis_manifest"; id: string; revision?: number }
      | { kind: "validation_report"; id: string }
      | { kind: "evidence_audit"; id: string }
      | { kind: "final_plan_candidate"; id: string; revision?: number }
      | { kind: "execution_handoff"; id: string };
    artifact:
      | PlanningRun
      | Architecture
      | Section
      | SectionRevision
      | Decision
      | Evidence
      | OpenQuestion
      | Conflict
      | Proposal
      | SynthesisInput
      | SynthesisManifest
      | ValidationReport
      | EvidenceAuditSnapshot
      | FinalPlanCandidate
      | FinalPlan
      | ExecutionHandoff;
  }[];
}

export interface QuestionScopeInput {
  type: "architecture" | "section";
  sectionID?: string;
}

export interface RecordQuestionInput {
  question: string;
  blocking: boolean;
  scope: QuestionScopeInput;
}

/**
 * Phase 2A.1 (Correction A): the model proposes a resolution; the question
 * keeps `status: "open"` (and stays blocking) until a PlanCommit containing
 * `resolve_question` applies the authoritative resolution.
 */
export interface ProposeQuestionResolutionInput {
  questionID: string;
  resolution: string;
}

export interface RaiseConflictInput {
  type: "decision" | "constraint" | "section" | "interface";
  refs: FlatMemoryRef[];
  description: string;
  severity: "warning" | "blocking";
}

/** Scope as prepared proposals carry it. */
export type ProposalScopeInput =
  | { type: "architecture" }
  | { type: "section"; sectionID: string };

/** Change kinds accepted by the proposal-intent boundary (Phase 2C vocabulary). */
export const PREPARED_CHANGE_KINDS = [
  "add_decision",
  "amend_decision",
  "amend_section",
  "add_architecture",
  "add_constraint",
  "raise_question",
  "resolve_question",
  "complete_architecture",
  "complete_section",
] as const;

export type PreparedChangeKind = (typeof PREPARED_CHANGE_KINDS)[number];

/**
 * Proposal-intent change content. The Phase 2A vocabulary is deliberately
 * closed (see the agent protocol document): content is shaped per kind, and
 * kinds whose payload semantics belong to the Phase 2B transaction engine are
 * rejected at this boundary.
 */
export interface ProposedDecisionInput {
  title: string;
  statement: string;
  rationale: string;
  scope?: { architecture?: boolean; sections?: string[] };
}

export interface PreparedChange {
  kind: PreparedChangeKind;
  ref?: FlatMemoryRef;
  content?: unknown;
}

export type ProposalTypeInput =
  | "design_checkpoint"
  | "architecture_completion"
  | "section_completion"
  | "amendment";

export interface PrepareProposalInput {
  type: ProposalTypeInput;
  scope: ProposalScopeInput;
  title: string;
  summary: string;
  changes: PreparedChange[];
}

/**
 * Phase 2C/2E2: completion requests are architecture- or section-scoped.
 * `kind: "section"` accepts NO authoritative inputs (brief §32): the Harness
 * resolves the active Section, its exact current approved revision, and the
 * deterministic state projection from Plan Memory.
 */
export interface RequestCompletionInput {
  kind: "architecture" | "section";
}

/**
 * Phase 2E2 §20: a narrow model-visible REQUEST to move the workflow focus.
 * The Harness performs the transition only after deterministic validation
 * (sanctioned `transitionActiveWork` — never a design Proposal, never user
 * approval, never arbitrary WorkRef mutation).
 */
export interface SectionFocusInput {
  sectionID: string;
}

/**
 * Phase 2D: one atomic semantic operation — establish the initial
 * project-specific Section DAG. Keys are PROPOSAL-DRAFT-LOCAL; the Harness
 * assigns authoritative SEC ids and resolves every dependency edge at freeze.
 */
export interface SectionDecompositionInput {
  sections: SectionDecompositionDraft[];
  /** Draft-local key of the section where Detail work begins. */
  initialSection: string;
}

/**
 * Phase 2E1 typed checkpoint input (protocol §6.3): the complete detailed
 * design of the ACTIVE section plus its two stable projections, in closed
 * shapes — no `content: unknown`, no revision identity (the Harness assigns
 * sectionID/revision/status/createdAt and stamps the contract projection at
 * freeze; hostile authoritative fields cannot be expressed).
 */
export interface SectionCheckpointInput {
  problem: string;
  design: string;
  interfaces: InterfaceSpec[];
  invariants: string[];
  failureModes: FailureMode[];
  /**
   * The exact dependency context of this design (protocol §6.5): every
   * structural dependency of the Section root, recorded exactly once.
   * `Dependency.contractRevision` is Harness-assigned at freeze (the exact
   * approved contract revision, or absent when the dependency has none) —
   * never model-supplied, never "latest".
   */
  dependencies: Dependency[];
  /** Committed decisions this revision stands on (must already exist). */
  decisions: DecisionID[];
  /** Existing open questions this revision references (must already exist). */
  openQuestions: QuestionID[];
  /** Committed Section roots this design affects (design metadata only). */
  impacts: SectionID[];
  projection: {
    compact: string;
    contract: {
      provides: string[];
      requires: string[];
      /** May only restate invariants the revision itself states. */
      invariants: string[];
      /** May only expose interfaces the revision itself defines. */
      interfaces: InterfaceRef[];
      /** Must resolve to decisions referenced by the revision, exactly. */
      decisions: DecisionRef[];
    };
  };
}

export interface PromoteEvidenceInput {
  claim: string;
  kind:
    | "file"
    | "symbol"
    | "interface"
    | "dependency"
    | "configuration"
    | "behavior"
    | "test"
    | "runtime"
    | "architecture";
  /** Flattened evidence scope; validated and branded by the controller. */
  scopeType: "run" | "architecture" | "section" | "decision";
  scopeSectionID?: string;
  scopeDecisionID?: string;
  criticality: "critical" | "supporting" | "informational";
  confidence: "direct" | "derived" | "uncertain";
  /** Observation ids backing a `direct` claim (required; must exist in this session's ledger). */
  observationIDs?: string[];
  /** Upstream evidence for a `derived` claim (required; must resolve). */
  derivedFrom?: { id: string; revision?: number }[];
}

export interface PreparedProposal {
  proposal: Proposal;
  /** Canonical content hash; a future Approval binds to exactly this. */
  hash: string;
}

export interface SynthesisRequestResult {
  run: PlanningRun;
  statusText: string;
}

/**
 * Phase 2F §24: the model supplies ONLY derived content. Every source ref is
 * flattened transport form; the controller validates and brands it. No
 * manifest identity, revision, input ref, base snapshot, architecture ref,
 * section list, or hash is accepted — the Harness supplies all of it.
 */
export interface SynthesisManifestDraftInput {
  crossSectionLinks: { statement: string; sources: SynthesisSourceRefInput[] }[];
  implementationOrder: { title: string; description: string; sections: { id: string; revision: number }[]; sources: SynthesisSourceRefInput[] }[];
  limitations: { statement: string; sources: SynthesisSourceRefInput[] }[];
  unresolvedFindings: { category: string; statement: string; sources?: SynthesisSourceRefInput[] }[];
}

/** Flattened exact source ref (transport form); parsed + branded by the controller. */
export interface SynthesisSourceRefInput {
  kind: "architecture" | "section" | "decision" | "constraint" | "question" | "conflict" | "evidence";
  id?: string;
  revision?: number;
}

export interface BeginSynthesisResult {
  input: SynthesisInput;
  /** Deterministic synthesis capsule (brief §21) — stable projection of the frozen input. */
  capsule: string;
}

export interface SubmitSynthesisManifestResult {
  manifest: SynthesisManifest;
  /** True when the exact content already existed (idempotent replay — brief §37). */
  idempotent: boolean;
}

/**
 * Phase 2G §37: request semantic validation of the exact current
 * (SynthesisInput, SynthesisManifest) pair. The model supplies NO arguments
 * and NO report content — the Harness resolves the pair, invokes the isolated
 * read-only validator, parses the strict output, validates its structure, and
 * persists the immutable ValidationReport.
 */
export interface RunSemanticValidationResult {
  report: ValidationReport;
  /**
   * True when an existing successful report for the EXACT identity was
   * returned without invoking the validator (anti-laundering, §25/§66).
   */
  idempotent: boolean;
  /** Deterministic validator-capsule rendering (audit/diagnostic surface). */
  capsule?: undefined;
}

/**
 * Phase 2G §37/§41: the narrow reopen REQUEST. `sectionID` names the target
 * Section (never its status/revision/validation — the Harness resolves the
 * exact approved revision). In synthesis, `findingIDs` selects findings from
 * the CURRENT findings report; in detail the reason is dependency_review and
 * findingIDs must be absent.
 */
export interface RequestReopenInput {
  sectionID: string;
  findingIDs?: string[];
}

/**
 * Phase 2H §45: the deterministic finalization outcome. The gate result is a
 * VALUE (never an exception): blocked/stale carry exact machine reasons and
 * persist nothing but the (possibly blocked) Evidence Audit (§46); pass
 * carries the frozen immutable FinalPlanCandidate with its deterministic
 * preview. The model supplies NO arguments and NO authoritative content.
 */
export interface RequestFinalizationResult {
  run: PlanningRun;
  gate: FinalizationGateResult;
  /** The audit built/reused for this request, when the synthesis trio existed (§46). */
  audit: EvidenceAuditSnapshot | undefined;
  /** Present only on a PASSING gate: the immutable candidate + its preview. */
  candidate?: { candidate: FinalPlanCandidate; idempotent: boolean; preview: string };
  statusText: string;
}

/**
 * Phase 2I §6/§7: prepare the formal final_plan Proposal from the CURRENT
 * FinalPlanCandidate. The model supplies NOTHING: the Harness reruns the
 * deterministic Finalization Gate (never trusting "the candidate was valid
 * when created"), requires the exact candidate identity, projects the
 * FinalPlan through the shared buildFinalPlanFromCandidate, Harness-assigns
 * FINAL-###@n, and freezes the single add_final_plan change. Idempotent: the
 * same current candidate returns the existing ready/awaiting Proposal (§19) —
 * a rejected Proposal is never resurrected, but a NEW explicit preparation
 * over the same still-current candidate is allowed.
 */
export interface PrepareFinalPlanResult {
  proposal: Proposal;
  /** Canonical proposal hash — the future Approval binds to exactly this. */
  hash: string;
  /** True when the existing current Final Proposal was returned unchanged (§19). */
  idempotent: boolean;
  /** The deterministic approval view rendered from the frozen Proposal. */
  preview: string;
}

/**
 * Phase 2J §77: the reentrant handoff recovery outcome. `ambiguous` means
 * the dispatch MAY have reached the host and the queryable-history recovery
 * could not yet prove either way — the run stays handoff_pending and the
 * delivery stays `dispatching` (fail closed, §62/§132); it NEVER means
 * "re-send".
 */
export type HandoffRecoveryResult =
  | { status: "not_applicable" }
  | { status: "already_completed" }
  | { status: "completed"; handoffID: HandoffID; deliveryKey: string }
  | { status: "in_flight"; handoffID: HandoffID }
  | { status: "prepared"; handoffID: HandoffID }
  | { status: "ambiguous"; handoffID: HandoffID }
  | { status: "retryable_failure"; handoffID: HandoffID; reason: string }
  | { status: "blocked"; code: import("./errors.js").UltraPlanErrorCode; message: string };

/** Outcome of a successful transaction, as orchestrated by the controller. */
export interface CommitResult {
  commit: PlanCommit;
  /** The proposal in its post-commit state (status = approved). */
  proposal: Proposal | undefined;
  /** The new HEAD snapshot (post-commit state). */
  snapshot: Snapshot | undefined;
  run: PlanningRun | undefined;
}

// ---------------------------------------------------------------------------
// Ref parsing
// ---------------------------------------------------------------------------

function requiredId(flat: FlatMemoryRef): string {
  if (!flat.id || flat.id.length === 0) {
    throw new UltraPlanError("invalid_scope", `A ${flat.kind} reference requires an id`);
  }
  return flat.id;
}

/** Build a canonical MemoryRef from the flattened model-facing shape. */
export function buildMemoryRef(flat: FlatMemoryRef): MemoryRef {
  switch (flat.kind) {
    case "architecture":
      return { kind: "architecture", ...(flat.revision !== undefined ? { revision: flat.revision } : {}) };
    case "section":
      return {
        kind: "section",
        id: SectionIDs.cast(requiredId(flat)),
        ...(flat.revision !== undefined ? { revision: flat.revision } : {}),
      };
    case "decision":
      return {
        kind: "decision",
        id: DecisionIDs.cast(requiredId(flat)),
        ...(flat.revision !== undefined ? { revision: flat.revision } : {}),
      };
    case "constraint":
      return { kind: "constraint", id: ConstraintIDs.cast(requiredId(flat)) };
    case "question":
      return { kind: "question", id: QuestionIDs.cast(requiredId(flat)) };
    case "conflict":
      return { kind: "conflict", id: ConflictIDs.cast(requiredId(flat)) };
    case "evidence":
      return {
        kind: "evidence",
        id: EvidenceIDs.cast(requiredId(flat)),
        ...(flat.revision !== undefined ? { revision: flat.revision } : {}),
      };
    case "proposal":
      return {
        kind: "proposal",
        id: ProposalIDs.cast(requiredId(flat)),
        ...(flat.revision !== undefined ? { revision: flat.revision } : {}),
      };
    case "snapshot":
      return { kind: "snapshot", id: SnapshotIDs.cast(requiredId(flat)) };
    case "commit":
      return { kind: "commit", id: CommitIDs.cast(requiredId(flat)) };
    case "final_plan":
      return {
        kind: "final_plan",
        id: FinalPlanIDs.cast(requiredId(flat)),
        ...(flat.revision !== undefined ? { revision: flat.revision } : {}),
      };
    case "execution_handoff":
      // Phase 2J §111: derived workflow artifact — it never appears inside a
      // MemoryRef (conflicts/proposals/traces); reads go through the
      // dedicated derived-artifact branch in readMemoryForRun.
      throw new UltraPlanError(
        "invalid_scope",
        "execution_handoff refs are read directly (plan_memory kind=execution_handoff), not as MemoryRef",
      );
    case "synthesis_input":
    case "synthesis_manifest":
    case "validation_report":
    case "evidence_audit":
    case "final_plan_candidate":
      // Derived artifacts are not first-class MemoryRef targets (conflicts
      // and proposal refs bind committed memory); they are read through the
      // dedicated read path.
      throw new UltraPlanError(
        "invalid_scope",
        `${flat.kind} refs are derived workflow artifacts, not committed Plan Memory references`,
      );
  }
}

function requireContent(change: PreparedChange): Record<string, unknown> {
  if (typeof change.content !== "object" || change.content === null) {
    throw new UltraPlanError("invalid_scope", `Change "${change.kind}" requires structured content`);
  }
  return change.content as Record<string, unknown>;
}

function readStringField(content: unknown, field: string): string {
  if (typeof content !== "object" || content === null) {
    throw new UltraPlanError("invalid_scope", `Change content requires "${field}"`);
  }
  const value = (content as Record<string, unknown>)[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new UltraPlanError("invalid_scope", `Change content requires a non-empty "${field}"`);
  }
  return value;
}

/** Non-empty trimmed string field of a typed draft (Phase 2E1 input contract). */
function requireTrimmed(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new UltraPlanError("invalid_scope", `A checkpoint draft requires a non-empty "${field}"`);
  }
  return value.trim();
}

/** Array of non-empty strings on a typed draft; absent resolves to []. */
function readStringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new UltraPlanError("invalid_scope", `A checkpoint draft requires "${field}" to be an array of strings`);
  }
  return value.map((entry, index) => requireTrimmed(entry, `${field}[${index}]`));
}

function readDecisionDraft(content: unknown): {
  title: string;
  statement: string;
  rationale: string;
  alternatives?: { description: string; rejectedBecause?: string }[];
  consequences?: string[];
  scope?: { architecture?: boolean; sections?: SectionID[] };
  evidence?: EvidenceRef[];
} {
  const record0 = requireContent({ kind: "add_decision", content } as unknown as PreparedChange);
  // Accept both flat drafts and the tool-level `{ decision: {...} }` wrapper.
  const nested = record0["decision"];
  const record =
    typeof nested === "object" && nested !== null
      ? (nested as Record<string, unknown>)
      : record0;
  const title = record["title"];
  const statement = record["statement"];
  const rationale = record["rationale"];
  if (typeof title !== "string" || typeof statement !== "string" || typeof rationale !== "string") {
    throw new UltraPlanError("invalid_scope", "Decision drafts require title, statement, and rationale");
  }
  const scope = record["scope"];
  return {
    title,
    statement,
    rationale,
    ...(Array.isArray(record["alternatives"]) ? { alternatives: record["alternatives"] as { description: string; rejectedBecause?: string }[] } : {}),
    ...(Array.isArray(record["consequences"]) ? { consequences: record["consequences"] as string[] } : {}),
    ...(typeof scope === "object" && scope !== null ? { scope: scope as { architecture?: boolean; sections?: SectionID[] } } : {}),
    ...(Array.isArray(record["evidence"]) ? { evidence: record["evidence"] as EvidenceRef[] } : {}),
  };
}

function readSectionRevisionDraft(content: unknown): SectionRevisionDraft {
  const record = requireContent({ kind: "amend_section", content } as unknown as PreparedChange);
  const problem = readStringField(record, "problem");
  const design = readStringField(record, "design");
  const compactProjection = readStringField(record, "compactProjection");
  const contractRecord = record["contract"];
  if (typeof contractRecord !== "object" || contractRecord === null) {
    throw new UltraPlanError("invalid_scope", "Section revision drafts require a contract projection");
  }
  const contract = contractRecord as Record<string, unknown>;
  return {
    problem,
    design,
    interfaces: (record["interfaces"] as SectionRevisionDraft["interfaces"]) ?? [],
    invariants: (record["invariants"] as string[]) ?? [],
    failureModes: (record["failureModes"] as SectionRevisionDraft["failureModes"]) ?? [],
    dependencies: (record["dependencies"] as SectionRevisionDraft["dependencies"]) ?? [],
    decisions: (record["decisions"] as SectionRevisionDraft["decisions"]) ?? [],
    openQuestions: (record["openQuestions"] as SectionRevisionDraft["openQuestions"]) ?? [],
    impacts: (record["impacts"] as SectionRevisionDraft["impacts"]) ?? [],
    compactProjection,
    contract: {
      provides: (contract["provides"] as string[]) ?? [],
      requires: (contract["requires"] as string[]) ?? [],
      invariants: (contract["invariants"] as string[]) ?? [],
      interfaces: (contract["interfaces"] as SectionRevisionDraft["contract"]["interfaces"]) ?? [],
      decisions: (contract["decisions"] as SectionRevisionDraft["contract"]["decisions"]) ?? [],
    },
  };
}

function readRaiseQuestionDraft(content: unknown): {
  question: string;
  blocking: boolean;
  scope: QuestionScopeInput;
} {
  const record = requireContent({ kind: "raise_question", content } as unknown as PreparedChange);
  const question = readStringField(record, "question");
  const scopeType = record["scopeType"];
  if (scopeType !== "architecture" && scopeType !== "section") {
    throw new UltraPlanError("invalid_scope", "raise_question requires scopeType architecture|section");
  }
  const sectionID = record["sectionID"];
  return {
    question,
    blocking: record["blocking"] === true,
    scope: { type: scopeType, ...(typeof sectionID === "string" ? { sectionID } : {}) },
  };
}

// -- Phase 2C draft readers (closed typed input contracts) --------------------

function readRecordArray(
  content: unknown,
  field: string,
  requiredFields: readonly string[],
): Record<string, unknown>[] {
  const record = requireContent({ kind: "add_architecture", content } as unknown as PreparedChange);
  const raw = record[field];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new UltraPlanError("invalid_scope", `Architecture draft "${field}" must be an array`);
  }
  return raw.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new UltraPlanError(
        "invalid_scope",
        `Architecture draft "${field}[${index}]" must be an object with ${requiredFields.join(", ")}`,
      );
    }
    const entry = item as Record<string, unknown>;
    for (const required of requiredFields) {
      const value = entry[required];
      if (typeof value !== "string" || value.length === 0) {
        throw new UltraPlanError(
          "invalid_scope",
          `Architecture draft "${field}[${index}]" requires a non-empty "${required}"`,
        );
      }
    }
    return entry;
  });
}

/**
 * Typed Architecture input contract (protocol §6): summary + components +
 * boundaries + dataFlows + principles, all in closed shapes; unresolved
 * question ids and decision references are resolved against real run state at
 * freeze time. No free-form blobs, no architecture DSL.
 */
function readArchitectureDraft(content: unknown): ArchitectureDraft {
  const record = requireContent({ kind: "add_architecture", content } as unknown as PreparedChange);
  // Accept both flat drafts and the tool-level `{ architecture: {...} }` wrapper.
  const nested = record["architecture"];
  const body: Record<string, unknown> =
    typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>) : record;
  const summary = body["summary"];
  if (typeof summary !== "string" || summary.trim().length === 0) {
    throw new UltraPlanError("invalid_scope", "Architecture draft requires a non-empty \"summary\"");
  }
  const components = readRecordArray(body, "components", ["name", "summary"]).map((c) => ({
    name: c["name"] as string,
    summary: c["summary"] as string,
  }));
  const componentNames = new Set(components.map((c) => c.name));
  if (componentNames.size !== components.length) {
    throw new UltraPlanError("invalid_scope", "Architecture draft component names must be unique");
  }
  const boundaries = readRecordArray(body, "boundaries", ["name", "description"]).map((b) => ({
    name: b["name"] as string,
    description: b["description"] as string,
  }));
  const boundaryNames = new Set(boundaries.map((b) => b.name));
  if (boundaryNames.size !== boundaries.length) {
    throw new UltraPlanError("invalid_scope", "Architecture draft boundary names must be unique");
  }
  const dataFlows = readRecordArray(body, "dataFlows", ["from", "to", "description"]).map((f) => ({
    from: f["from"] as string,
    to: f["to"] as string,
    description: f["description"] as string,
  }));
  const principles = readRecordArray(body, "principles", ["statement"]).map((p) => ({
    statement: p["statement"] as string,
  }));
  const rawUnresolved = body["unresolvedQuestionIDs"];
  if (rawUnresolved !== undefined) {
    if (
      !Array.isArray(rawUnresolved) ||
      rawUnresolved.some((id) => typeof id !== "string" || id.length === 0)
    ) {
      throw new UltraPlanError(
        "invalid_scope",
        "Architecture draft \"unresolvedQuestionIDs\" must be an array of question ids",
      );
    }
  }
  const rawBasedOn = body["basedOn"];
  if (rawBasedOn !== undefined) {
    if (!Array.isArray(rawBasedOn) || rawBasedOn.some((id) => typeof id !== "string" || id.length === 0)) {
      throw new UltraPlanError(
        "invalid_scope",
        "Architecture draft \"basedOn\" must be an array of decision ids",
      );
    }
  }
  return {
    summary,
    components,
    boundaries,
    dataFlows,
    principles,
    ...(rawUnresolved !== undefined
      ? { unresolvedQuestionIDs: (rawUnresolved as string[]).map((id) => QuestionIDs.cast(id)) }
      : {}),
    ...(rawBasedOn !== undefined
      ? { basedOn: (rawBasedOn as string[]).map((id) => DecisionIDs.cast(id)) }
      : {}),
  };
}

/** Closed constraint draft: statement + source + severity; the Harness freezes the rest. */
function readConstraintDraft(content: unknown): ConstraintDraft {
  const record = requireContent({ kind: "add_constraint", content } as unknown as PreparedChange);
  const nested = record["constraint"];
  const body: Record<string, unknown> =
    typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>) : record;
  const statement = readStringField(body, "statement");
  const source = body["source"];
  if (source !== "user" && source !== "repository" && source !== "environment" && source !== "runtime") {
    throw new UltraPlanError(
      "invalid_scope",
      "Constraint draft requires source user|repository|environment|runtime",
    );
  }
  const severity = body["severity"];
  if (severity !== "hard" && severity !== "soft") {
    throw new UltraPlanError("invalid_scope", "Constraint draft requires severity hard|soft");
  }
  return { statement, source, severity };
}

function buildEvidenceRef(flat: { id: string; revision?: number }): EvidenceRef {
  return { id: EvidenceIDs.cast(flat.id), ...(flat.revision !== undefined ? { revision: flat.revision } : {}) };
}

function observationToSource(observation: Observation): import("../repository/evidence.js").EvidenceSource {
  const locator: SourceLocator | undefined = observation.source;
  if (!locator) {
    return { type: "runtime", command: observation.tool };
  }
  switch (locator.kind) {
    case "file":
      return {
        type: "file",
        path: locator.path,
        ...(locator.range ? { range: locator.range } : {}),
      };
    case "symbol":
      return { type: "symbol", ...(locator.path ? { path: locator.path } : {}), symbol: locator.symbol };
    case "command":
      return { type: "command", command: locator.command };
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export interface ControllerOptions {
  store: PlanStore;
  /** Session-scoped observation ledger backing evidence provenance. */
  ledger?: ObservationLedgerRef;
  /**
   * Explicit plan-entry admissions (Phase 2A.1 Correction B). Required for
   * start authorization; a fresh in-memory ledger is created when omitted so
   * the invariant (no admission → no start) always holds.
   */
  admissions?: StartAdmissionLedger;
  /** The command name whose execution issues a start admission. */
  startCommand?: string;
  runtime?: UltraPlanRuntime;
  /**
   * Phase 2G: the isolated read-only semantic validator (Core boundary — the
   * runtime adapter owns the model invocation). When absent,
   * run_semantic_validation fails honestly with `validator_unavailable`
   * instead of faking a result (brief §10).
   */
  semanticValidator?: SemanticValidator;
  /**
   * Phase 2J: the runtime handoff bundle — the narrow execution adapter plus
   * the resolved deterministic execution role policy (§29/§30). When absent,
   * a handoff_pending run stays pending with `execution_runtime_unavailable`
   * (never silently faked, §115/§116).
   */
  executionRuntime?: {
    adapter: import("../runtime/types.js").ExecutionRuntimeAdapter;
    /** "provider/model"; absent = host default model (§57 safe default). */
    executionModel?: string;
    /** Defaults to the host-native Build agent (§30). */
    executionAgent?: string;
  };
  now?: () => Timestamp;
}

/** Minimal ledger surface the controller needs (see repository/observations.ts). */
export interface ObservationLedgerRef {
  list(sessionID: string): Promise<Observation[]>;
}

export interface StartOrResumeResult {
  run: PlanningRun;
  /** True when this call created the run; false when an active run was resumed. */
  created: boolean;
  /** Runtime activation result; null when no runtime is bound. */
  activation: RuntimeActivationResult | null;
  /** Deterministic status block rendered from structured state. */
  statusText: string;
  /**
   * Phase 2J: present when the resumed run was handoff_pending and the
   * Harness recovery/continuation path ran the runtime Build handoff (§35/§78).
   */
  handoff?: HandoffRecoveryResult;
}

export class UltraPlanController {
  private readonly store: PlanStore;
  private readonly ledger: ObservationLedgerRef | undefined;
  private readonly admissions: StartAdmissionLedger;
  private readonly startCommand: string;
  private readonly runtime: UltraPlanRuntime | undefined;
  private readonly semanticValidator: SemanticValidator | undefined;
  private readonly executionRuntime: ControllerOptions["executionRuntime"];
  private readonly now: () => Timestamp;

  constructor(options: ControllerOptions) {
    this.store = options.store;
    this.ledger = options.ledger;
    this.admissions = options.admissions ?? new InMemoryStartAdmissionLedger(options.now);
    this.startCommand = options.startCommand ?? "ultra-plan";
    this.runtime = options.runtime;
    this.semanticValidator = options.semanticValidator;
    this.executionRuntime = options.executionRuntime;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** The store behind this controller (read-only use by host surfaces). */
  get planStore(): PlanStore {
    return this.store;
  }

  /**
   * Harness-only (Phase 2A.1): record a one-shot start admission. Called by
   * the plugin's `command.execute.before` hook when — and only when — the
   * user explicitly invokes the /ultra-plan command. The model has no path to
   * this method and no tool argument can forge an admission.
   */
  issueStartAdmission(sessionID: string): StartAdmission {
    return this.admissions.issue(sessionID, this.startCommand, this.now());
  }

  // -- /ultra-plan entry point ----------------------------------------------

  /**
   * `/ultra-plan` semantics (spec §3), gated by explicit plan-entry admission
   * (Phase 2A.1 Correction B):
   *
   * - no active run            → create a run (fresh admission required);
   * - active run               → resume/report the same run (admission required);
   * - completed/aborted run    → create a NEW run (fresh admission required);
   * - handoff_pending          → resume the run; recovery/handoff remains
   *                              Harness-authoritative and is never re-entered
   *                              by /ultra-plan.
   *
   * Consumes exactly one admission per invocation. Any invocation without a
   * valid admission fails with `start_not_authorized`.
   *
   * Goal semantics (Phase 2C §12): the goal statement is USER-authored — it
   * only ever enters through the arguments of an explicit /ultra-plan command
   * invocation, never through a bare model tool call. On create it seeds the
   * run; on resume it fills an EMPTY goal only (a user re-invocation with
   * arguments can complete a goal, but never silently rewrites an existing
   * one). It is working state, not committed Plan Memory, so no approval
   * proposal is required for the user's own statement.
   */
  async startOrResume(sessionID: string, goal?: string): Promise<StartOrResumeResult> {
    this.admissions.consume(sessionID, this.startCommand, this.now());

    const existing = await this.store.findActiveRunBySession(sessionID);

    if (existing) {
      let resumed = existing;
      const statedGoal = goal?.trim();
      if (statedGoal && resumed.goal.statement.trim() === "") {
        resumed = await this.store.saveRun({ ...resumed, goal: { statement: statedGoal } });
      }
      // Phase 2J §35/§78: a handoff_pending run resumes through the Harness's
      // deterministic recovery/continuation path — the runtime Build handoff
      // is Harness-owned after Final Approval and requires no model decision
      // (zero authority parameters; /ultra-plan is the user's continuation
      // command, not a handoff authorization).
      const handoff = await this.maybeRecoverHandoff(sessionID);
      await this.store.appendEvent(resumed.id, { type: "run.resumed", sessionID });
      const activation = await this.activate(resumed);
      const run = (await this.store.getRun(resumed.id)) ?? resumed;
      const result = await finish(this.store, run, false, activation);
      return { ...result, ...(handoff ? { handoff } : {}) };
    }

    const at = this.now();
    const seq = await this.store.nextPlanSequence();
    const run = await this.store.createRun({
      id: PlanIDs.from(seq),
      sessionID,
      lifecycle: "active",
      stage: "discovery",
      revision: 1,
      goal: { statement: goal ?? "" },
      constraints: [],
      sections: [],
      decisions: [],
      openQuestions: [],
      conflicts: [],
      createdAt: at,
      updatedAt: at,
    });
    await this.store.appendEvent(run.id, { type: "run.created", sessionID });
    const activation = await this.activate(run);
    return finish(this.store, run, true, activation);
  }

  /** Deterministic status for the session's active run, or null. */
  async statusOf(sessionID: string): Promise<string | null> {
    const run = await this.store.findActiveRunBySession(sessionID);
    return run ? renderRunStatus(this.store, run) : null;
  }

  /** Full status report, including runs that already completed (read-only). */
  async statusReport(
    sessionID: string,
  ): Promise<{ run: PlanningRun | undefined; statusText: string }> {
    const run = await this.store.findLatestRunBySession(sessionID);
    return {
      run,
      statusText: run ? await renderRunStatus(this.store, run) : renderNoRunStatus(sessionID),
    };
  }

  // -- Authorization (the enforcement gate for every model-facing op) -------

  /**
   * Resolve the run a tool invocation applies to and assert the capability
   * matrix grants it. Single authoritative path — tools carry no stage rules
   * of their own. For detail runs with a Section focus, the committed
   * Section root under activeWork is resolved from the store and passed as
   * capability CONTEXT so the matrix can distinguish the revisionless vs
   * checkpointed substates (Phase 2E1 §20 + 2E2 §48); for synthesis runs the
   * latest derived artifacts pick the synthesis substate (Phase 2F §43).
   */
  async authorizeTool(
    sessionID: string,
    contractName: string,
  ): Promise<PlanningRun | undefined> {
    const contract = TOOL_CONTRACTS[contractName];
    if (!contract) {
      throw new UltraPlanError("capability_not_available", `Unknown tool contract "${contractName}"`);
    }
    const run = contract.requiresActiveRun
      ? await this.store.findActiveRunBySession(sessionID)
      : (await this.store.findActiveRunBySession(sessionID)) ??
        (await this.store.findLatestRunBySession(sessionID));
    let context: CapabilityContext = {};
    if (run?.stage === "detail" && run.activeWork?.type === "section") {
      const activeSection = await this.store.getSection(run.id, run.activeWork.id);
      if (activeSection) context = { activeSection };
    } else if (run?.stage === "synthesis") {
      // Phase 2F §43 + Phase 2G §34 + Phase 2H §53: the synthesis substate
      // derives from the latest frozen input, its latest manifest, the CURRENT
      // validation report, and the CURRENT FinalPlanCandidate (a report/candidate
      // bound to a superseded identity picks no substate).
      const [latestInput, manifests] = await Promise.all([
        this.store.getLatestSynthesisInput(run.id),
        this.store.listSynthesisManifests(run.id),
      ]);
      const latestManifest = latestInput
        ? manifests
            .filter((manifest) => manifest.input.id === latestInput.id)
            .reduce<SynthesisManifest | undefined>(
              (latest, manifest) => (latest === undefined || manifest.revision > latest.revision ? manifest : latest),
              undefined,
            )
        : undefined;
      let report: ValidationReport | undefined;
      if (latestInput && latestManifest) {
        report =
          (await this.store.findValidationReportByIdentity(run.id, {
            inputHash: latestInput.hash,
            manifestHash: latestManifest.hash,
            validatorProtocol: SEMANTIC_VALIDATION_PROTOCOL,
          })) ?? undefined;
      }
      const finalization = await resolveSynthesisFinalization(this.store, run, latestInput, latestManifest, report);
      const candidateContext = finalization.candidate;
      // Phase 2I §22: the narrow final-proposal context — the current
      // final_plan Proposal (ready/awaiting) that binds the CURRENT candidate.
      // Only this substate grants request_user_approval during synthesis; the
      // binding (type + candidate id/revision/hash + gate identity) is
      // re-verified independently at the approval boundary itself.
      const finalProposal = await resolveCurrentFinalProposal(this.store, run, {
        candidateCurrent: candidateContext?.current === true,
      });
      context = {
        synthesis: {
          hasInput: latestInput !== undefined,
          hasManifest: latestManifest !== undefined,
          ...(report ? { report: { result: report.result } } : {}),
          ...(candidateContext ? { candidate: { current: candidateContext.current } } : {}),
          ...(finalProposal ? { finalProposal: { status: finalProposal.proposal.status as "ready" | "awaiting_approval", current: finalProposal.current } } : {}),
        },
      };
    }
    assertCapability(run, contract.capability, context);
    return run;
  }

  // -- Read-only Plan Memory (spec §20) --------------------------------------

  async readMemory(sessionID: string, query: MemoryQuery): Promise<MemoryReadResult> {
    const run = requireRun(await this.authorizeTool(sessionID, "plan_memory"), "read_memory");
    return this.readMemoryForRun(run, query);
  }

  /** Read implementation shared by the tool surface and tests. */
  async readMemoryForRun(run: PlanningRun, query: MemoryQuery): Promise<MemoryReadResult> {
    const planID = run.id;
    const result: MemoryReadResult = {
      planID,
      headSnapshot: run.headSnapshot,
      queried: query.ref,
      artifacts: [],
    };

    if (query.dependenciesOf !== undefined) {
      const sectionID = SectionIDs.cast(query.dependenciesOf);
      const section = await this.store.getSection(planID, sectionID);
      if (!section) {
        throw new UltraPlanError("unknown_reference", `Section ${sectionID} is not committed`, {
          ref: query.dependenciesOf,
        });
      }
      result.artifacts.push({ ref: { kind: "section", id: sectionID }, artifact: section });
      for (const dep of section.dependencies) {
        // §30: structural dependencies are returned even before dependency
        // contracts exist — a missing SectionContract never blocks reading
        // the Section root (contracts are produced by approved Section
        // design, a later phase).
        const depSection = await this.store.getSection(planID, dep);
        if (!depSection) continue;
        result.artifacts.push({ ref: { kind: "section", id: dep }, artifact: depSection });
        if (depSection.approvedRevision !== undefined) {
          const revisionRef: SectionRevisionRef = { id: dep, revision: depSection.approvedRevision };
          const revision = await this.store.getSectionRevision(planID, revisionRef);
          if (revision) {
            result.artifacts.push({
              ref: { kind: "section", id: dep, revision: depSection.approvedRevision },
              artifact: revision,
            });
          }
        }
      }
      return result;
    }

    if (query.ref === undefined) {
      // No ref: compact run-level read (identity, not a memory dump).
      result.artifacts.push({ ref: { kind: "run" }, artifact: run });
      const architecture = await this.store.getArchitecture(planID);
      if (architecture) {
        result.artifacts.push({ ref: { kind: "architecture" }, artifact: architecture });
      }
      return result;
    }

    // Phase 2F: derived artifacts are not committed Plan Memory, so they ride
    // dedicated result-ref shapes instead of the MemoryRef union.
    if (query.ref.kind === "synthesis_input") {
      const id = requiredId(query.ref);
      result.artifacts.push({
        ref: { kind: "synthesis_input", id },
        artifact: await this.readRef(planID, run, query.ref),
      });
      return result;
    }
    if (query.ref.kind === "synthesis_manifest") {
      const id = requiredId(query.ref);
      result.artifacts.push({
        ref: { kind: "synthesis_manifest", id, ...(query.ref.revision !== undefined ? { revision: query.ref.revision } : {}) },
        artifact: await this.readRef(planID, run, query.ref),
      });
      return result;
    }
    if (query.ref.kind === "validation_report") {
      const id = requiredId(query.ref);
      result.artifacts.push({
        ref: { kind: "validation_report", id },
        artifact: await this.readRef(planID, run, query.ref),
      });
      return result;
    }
    if (query.ref.kind === "evidence_audit") {
      const id = requiredId(query.ref);
      result.artifacts.push({
        ref: { kind: "evidence_audit", id },
        artifact: await this.readRef(planID, run, query.ref),
      });
      return result;
    }
    if (query.ref.kind === "final_plan_candidate") {
      const id = requiredId(query.ref);
      result.artifacts.push({
        ref: { kind: "final_plan_candidate", id, ...(query.ref.revision !== undefined ? { revision: query.ref.revision } : {}) },
        artifact: await this.readRef(planID, run, query.ref),
      });
      return result;
    }
    if (query.ref.kind === "execution_handoff") {
      const id = requiredId(query.ref);
      result.artifacts.push({
        ref: { kind: "execution_handoff", id },
        artifact: await this.readRef(planID, run, query.ref),
      });
      return result;
    }

    const ref = buildMemoryRef(query.ref);
    result.artifacts.push({ ref, artifact: await this.readRef(planID, run, query.ref) });
    return result;
  }

  private async readRef(
    planID: PlanID,
    run: PlanningRun,
    flat: FlatMemoryRef,
  ): Promise<MemoryReadResult["artifacts"][number]["artifact"]> {
    // Phase 2F §41: exact derived-artifact reads. A synthesis_input read is
    // exact by id (historical inputs never resolve to latest — the id IS the
    // identity); a synthesis_manifest read with a revision is an exact
    // historical read (missing revision → error, never "latest"), without one
    // it returns the newest revision of that manifest id.
    switch (flat.kind) {
      case "synthesis_input": {
        const id = requiredId(flat);
        const input = await this.store.getSynthesisInput(planID, SynthesisInputIDs.cast(id));
        if (!input) {
          throw new UltraPlanError("unknown_reference", `SynthesisInput ${id} does not exist in run ${planID}`);
        }
        return input;
      }
      case "synthesis_manifest": {
        const id = requiredId(flat);
        const manifest = await this.store.getSynthesisManifest(
          planID,
          SynthesisManifestIDs.cast(id),
          flat.revision,
        );
        if (!manifest) {
          throw new UltraPlanError(
            "unknown_reference",
            flat.revision === undefined
              ? `SynthesisManifest ${id} does not exist in run ${planID}`
              : `SynthesisManifest ${id}@${flat.revision} does not exist (exact revisions are never resolved to latest)`,
          );
        }
        return manifest;
      }
      case "validation_report": {
        // Phase 2G §59: exact reads only — an unknown VAL id is an error,
        // never resolved to the current report (the current report is
        // discoverable from status).
        const id = requiredId(flat);
        const report = await this.store.getValidationReport(planID, ValidationReportIDs.cast(id));
        if (!report) {
          throw new UltraPlanError(
            "unknown_reference",
            `ValidationReport ${id} does not exist in run ${planID} (exact ids are never resolved to the current report)`,
          );
        }
        return report;
      }
      case "evidence_audit": {
        // Phase 2H §56: exact reads only — an unknown AUD id is an error,
        // never resolved to the current audit.
        const id = requiredId(flat);
        const audit = await this.store.getEvidenceAudit(planID, EvidenceAuditIDs.cast(id));
        if (!audit) {
          throw new UltraPlanError(
            "unknown_reference",
            `EvidenceAudit ${id} does not exist in run ${planID} (exact ids are never resolved to the current audit)`,
          );
        }
        return audit;
      }
      case "final_plan_candidate": {
        // Phase 2H §56: with a revision this is an exact historical read
        // (missing revisions are errors, never resolved to latest); without
        // one it returns the newest revision of that candidate id. A
        // historical candidate NEVER silently resolves to the current one
        // when an exact revision is supplied.
        const id = requiredId(flat);
        const candidate = await this.store.getFinalPlanCandidate(planID, FinalPlanCandidateIDs.cast(id), flat.revision);
        if (!candidate) {
          throw new UltraPlanError(
            "unknown_reference",
            flat.revision === undefined
              ? `FinalPlanCandidate ${id} does not exist in run ${planID}`
              : `FinalPlanCandidate ${id}@${flat.revision} does not exist (exact revisions are never resolved to latest or to the current candidate)`,
          );
        }
        return candidate;
      }
      case "execution_handoff": {
        // Phase 2J §111: exact reads only — an unknown HANDOFF id is an
        // error, never resolved to anything else. The delivery workflow
        // record (host runtime metadata) is deliberately not exposed here.
        const id = requiredId(flat);
        const handoff = await this.store.getExecutionHandoff(planID, HandoffIDs.cast(id));
        if (!handoff) {
          throw new UltraPlanError(
            "unknown_reference",
            `ExecutionHandoff ${id} does not exist in run ${planID} (exact ids are never resolved)`,
          );
        }
        return handoff;
      }
      case "architecture": {
        const architecture = await this.store.getArchitecture(planID, flat.revision);
        if (!architecture) {
          throw new UltraPlanError(
            "unknown_reference",
            flat.revision === undefined
              ? "No committed architecture exists"
              : `Architecture revision ${flat.revision} does not exist (exact revisions are never resolved to latest)`,
            { revision: flat.revision },
          );
        }
        return architecture;
      }
      case "section": {
        const sectionID = SectionIDs.cast(requiredId(flat));
        if (flat.revision !== undefined) {
          const revision = await this.store.getSectionRevision(planID, {
            id: sectionID,
            revision: flat.revision,
          });
          if (!revision) {
            throw new UltraPlanError(
              "unknown_reference",
              `Section ${sectionID}@${flat.revision} does not exist (exact revisions are never resolved to latest)`,
            );
          }
          return revision;
        }
        const section = await this.store.getSection(planID, sectionID);
        if (!section) {
          throw new UltraPlanError("unknown_reference", `Section ${sectionID} is not committed`);
        }
        return section;
      }
      case "decision": {
        if (flat.revision === undefined) {
          throw new UltraPlanError("invalid_scope", "Decision reads require an exact revision");
        }
        const decision = await this.store.getDecision(planID, {
          id: DecisionIDs.cast(requiredId(flat)),
          revision: flat.revision,
        });
        if (!decision) {
          throw new UltraPlanError(
            "unknown_reference",
            `Decision ${flat.id}@${flat.revision} does not exist (exact revisions are never resolved to latest)`,
          );
        }
        return decision;
      }
      case "evidence": {
        const evidence = await this.store.getEvidence(planID, {
          id: EvidenceIDs.cast(requiredId(flat)),
          ...(flat.revision !== undefined ? { revision: flat.revision } : {}),
        });
        if (!evidence) {
          throw new UltraPlanError("unknown_reference", `Evidence ${flat.id} does not exist`);
        }
        return evidence;
      }
      case "question": {
        const id = requiredId(flat);
        const question = run.openQuestions.find((q) => q.id === id);
        if (!question) {
          throw new UltraPlanError("unknown_reference", `Question ${id} does not exist in run ${run.id}`);
        }
        return question;
      }
      case "conflict": {
        const id = requiredId(flat);
        const conflict = run.conflicts.find((c) => c.id === id);
        if (!conflict) {
          throw new UltraPlanError("unknown_reference", `Conflict ${id} does not exist in run ${run.id}`);
        }
        return conflict;
      }
      case "proposal": {
        const id = requiredId(flat);
        const proposal = await this.store.getProposal(planID, ProposalIDs.cast(id));
        if (!proposal) {
          throw new UltraPlanError("unknown_reference", `Proposal ${id} does not exist`);
        }
        return proposal;
      }
      case "final_plan": {
        // Phase 2I §47: exact FinalPlan reads. With a revision this is an
        // exact historical read (missing revisions are errors, never resolved
        // to latest); without one, the newest revision of that FinalPlan id.
        const id = requiredId(flat);
        const plan = await this.store.getFinalPlan(planID, FinalPlanIDs.cast(id), flat.revision);
        if (!plan) {
          throw new UltraPlanError(
            "unknown_reference",
            flat.revision === undefined
              ? `FinalPlan ${id} does not exist in run ${planID} (it is committed only by a final_plan PlanCommit)`
              : `FinalPlan ${id}@${flat.revision} does not exist (exact revisions are never resolved to latest)`,
          );
        }
        return plan;
      }
      case "snapshot":
      case "commit":
      case "constraint":
        throw new UltraPlanError(
          "invalid_scope",
          `Reading ${flat.kind} refs is not part of the Phase 2A read boundary`,
        );
    }
  }

  // -- Working-state operations ----------------------------------------------

  async recordQuestion(sessionID: string, input: RecordQuestionInput): Promise<OpenQuestion> {
    const run = requireRun(await this.authorizeTool(sessionID, "ultraplan_record_question"), "record_question");
    const scope = await this.questionScope(run, input.scope);

    const question: OpenQuestion = {
      id: QuestionIDs.from(nextSequence(run.openQuestions.map((q) => q.id), QuestionIDs.prefix)),
      question: input.question,
      blocking: input.blocking,
      scope,
      status: "open",
    };
    await this.store.saveRun({
      ...run,
      openQuestions: [...run.openQuestions, question],
    });
    return question;
  }

  /**
   * Phase 2A.1 (Correction A): record a CANDIDATE resolution for an open
   * question. The question's `status` stays `"open"` and it remains blocking;
   * the authoritative open → resolved transition is applied only by a
   * PlanCommit whose proposal contains a `resolve_question` change (Phase 2B).
   */
  async proposeQuestionResolution(
    sessionID: string,
    input: ProposeQuestionResolutionInput,
  ): Promise<OpenQuestion> {
    const run = requireRun(
      await this.authorizeTool(sessionID, "ultraplan_propose_question_resolution"),
      "propose_question_resolution",
    );
    const existing = run.openQuestions.find((q) => q.id === input.questionID);
    if (!existing) {
      throw new UltraPlanError(
        "unknown_reference",
        `Question ${input.questionID} does not exist in run ${run.id}`,
      );
    }
    const updated: OpenQuestion = {
      ...existing,
      status: existing.status,
      proposedResolution: { text: input.resolution, proposedAt: this.now() },
    };
    await this.store.saveRun({
      ...run,
      openQuestions: run.openQuestions.map((q) => (q.id === updated.id ? updated : q)),
    });
    return updated;
  }

  async raiseConflict(sessionID: string, input: RaiseConflictInput): Promise<Conflict> {
    const run = requireRun(await this.authorizeTool(sessionID, "ultraplan_raise_conflict"), "raise_conflict");
    const refs: MemoryRef[] = [];
    for (const flat of input.refs) {
      const ref = buildMemoryRef(flat);
      await this.assertRefResolves(run, ref);
      refs.push(ref);
    }

    const conflict: Conflict = {
      id: ConflictIDs.from(nextSequence(run.conflicts.map((c) => c.id), ConflictIDs.prefix)),
      type: input.type,
      refs,
      description: input.description,
      severity: input.severity,
      status: "open",
    };
    await this.store.saveRun({ ...run, conflicts: [...run.conflicts, conflict] });
    return conflict;
  }

  // -- Repository evidence promotion ------------------------------------------

  async promoteEvidence(sessionID: string, input: PromoteEvidenceInput): Promise<Evidence> {
    const run = requireRun(await this.authorizeTool(sessionID, "ultraplan_promote_evidence"), "promote_evidence");

    if (input.confidence === "direct" && (!input.observationIDs || input.observationIDs.length === 0)) {
      throw new UltraPlanError(
        "missing_provenance",
        "Direct evidence requires at least one observation id made in this session",
      );
    }
    if (input.confidence === "derived" && (!input.derivedFrom || input.derivedFrom.length === 0)) {
      throw new UltraPlanError(
        "missing_provenance",
        "Derived evidence requires derivedFrom references to upstream evidence",
      );
    }

    const now = this.now();
    const sources: EvidenceSource[] = [];
    let freshness: "fresh" | "needs_validation" = "fresh";
    const scope = this.buildEvidenceScope(input);

    if (input.confidence === "direct") {
      const observations = (await this.ledger?.list(sessionID)) ?? [];
      for (const id of input.observationIDs ?? []) {
        const observation = observations.find((o) => o.id === id);
        if (!observation) {
          throw new UltraPlanError(
            "unknown_reference",
            `Observation ${id} was not made in this session; direct evidence cannot be created from model text alone`,
          );
        }
        sources.push(observationToSource(observation));
      }
    }

    const derivedFrom: EvidenceRef[] = [];
    if (input.confidence === "derived") {
      for (const flat of input.derivedFrom ?? []) {
        const ref = buildEvidenceRef(flat);
        const upstream = await this.store.getEvidence(run.id, ref);
        if (!upstream) {
          throw new UltraPlanError(
            "unknown_reference",
            `Upstream evidence ${flat.id ?? "?"} does not exist`,
          );
        }
        if (upstream.freshness !== "fresh") freshness = "needs_validation";
        derivedFrom.push(ref);
      }
    }

    if (input.confidence === "uncertain") {
      // Uncertain evidence is by definition unverified: it can never claim freshness.
      freshness = "needs_validation";
    }

    const evidence: Evidence = {
      id: EvidenceIDs.from(
        nextSequence((await this.store.listEvidence(run.id)).map((e) => e.id), EvidenceIDs.prefix),
      ),
      revision: 1,
      kind: input.kind,
      claim: input.claim,
      source: sources,
      scope,
      confidence: input.confidence,
      criticality: input.criticality,
      freshness,
      status: "active",
      ...(derivedFrom.length > 0 ? { derivedFrom } : {}),
      discoveredAt: now,
      lastValidatedAt: now,
    };
    await this.store.putEvidence(run.id, evidence);
    return evidence;
  }

  /** Validate + brand the flattened evidence scope. */
  private buildEvidenceScope(input: PromoteEvidenceInput): EvidenceScope {
    switch (input.scopeType) {
      case "run":
        return { kind: "run" };
      case "architecture":
        return { kind: "architecture" };
      case "section":
        if (!input.scopeSectionID) {
          throw new UltraPlanError("invalid_scope", "Section-scoped evidence requires a section id");
        }
        return { kind: "section", sectionID: SectionIDs.cast(input.scopeSectionID) };
      case "decision":
        if (!input.scopeDecisionID) {
          throw new UltraPlanError("invalid_scope", "Decision-scoped evidence requires a decision id");
        }
        return { kind: "decision", decisionID: DecisionIDs.cast(input.scopeDecisionID) };
    }
  }

  // -- Proposal intent ---------------------------------------------------------

  async prepareProposal(sessionID: string, input: PrepareProposalInput): Promise<PreparedProposal> {
    const run = requireRun(await this.authorizeTool(sessionID, "ultraplan_prepare_proposal"), "prepare_proposal");
    return this.buildProposal(run, input.type, input.scope, input.title, input.summary, input.changes);
  }

  /**
   * Phase 2C discovery → architecture: the model REQUESTS the transition; the
   * Harness decides whether it is structurally legal. Deliberately minimal
   * deterministic prerequisites (no invented readiness heuristics): active
   * run in stage=discovery (capability gate), a structured goal (so planning
   * context is never goal-less), and no prior architecture workflow. The
   * transition itself is the standard state-machine edge discovery →
   * architecture, audited by the run.stage_changed event.
   */
  async requestArchitecture(sessionID: string): Promise<SynthesisRequestResult> {
    const run = requireRun(await this.authorizeTool(sessionID, "ultraplan_request_architecture"), "request_architecture");
    if (run.stage !== "discovery") {
      throw new UltraPlanError(
        "capability_not_available",
        `request_architecture is a discovery-stage operation (run is in ${run.stage})`,
        { stage: run.stage },
      );
    }
    if (run.goal.statement.trim() === "") {
      throw new UltraPlanError(
        "goal_required",
        "Discovery cannot complete without a structured goal; re-invoke /ultra-plan with the goal as arguments",
        { planID: run.id },
      );
    }
    const moved = transitionStage(run, "architecture");
    const saved = await this.store.saveRun(moved);
    return { run: saved, statusText: await renderRunStatus(this.store, saved) };
  }

  /**
   * Phase 2C §24 + Phase 2E2 §6/§32: ONE semantic completion operation.
   * `kind: "architecture"` prepares the architecture_completion proposal
   * (complete_architecture at the exact committed revision). `kind: "section"`
   * (restored in Phase 2E2) targets the ACTIVE section's exact current
   * approved checkpoint — the model supplies no revision/status/dependencies;
   * the Harness resolves everything authoritative and returns PRECISE blocker
   * errors when deterministic gates fail (brief §7) instead of preparing a
   * doomed proposal.
   */
  async requestCompletion(sessionID: string, input: RequestCompletionInput): Promise<PreparedProposal> {
    // authorizeTool performs the CONTEXTUAL capability assertion (the
    // checkpointed detail substate grants request_completion; a redundant
    // contextless requireRun here would wrongly resolve the revisionless
    // substate and deny it).
    const resolved = await this.authorizeTool(sessionID, "ultraplan_request_completion");
    if (!resolved) {
      throw new UltraPlanError(
        "no_active_run",
        `Capability "request_completion" requires an active PlanningRun; invoke /ultra-plan first`,
        { capability: "request_completion" },
      );
    }
    const run = resolved;
    if (input.kind === "architecture") {
      if (run.stage !== "architecture") {
        throw new UltraPlanError(
          "invalid_scope",
          `architecture completion requires stage=architecture (run is in ${run.stage})`,
          { stage: run.stage },
        );
      }
      const architecture = await this.store.getArchitecture(run.id);
      if (!architecture) {
        throw new UltraPlanError(
          "unknown_reference",
          "No committed Architecture exists to complete; prepare an architecture proposal with add_architecture first",
          { planID: run.id },
        );
      }
      return this.buildProposal(
        run,
        "architecture_completion",
        { type: "architecture" },
        `Complete ARCH@${architecture.revision}`,
        "Declare the approved top-level architecture complete; it becomes the basis for Detail decomposition.",
        [{ kind: "complete_architecture", ref: { kind: "architecture", revision: architecture.revision } }],
      );
    }
    // -- kind: "section" (Phase 2E2) ------------------------------------------
    if (run.stage !== "detail") {
      throw new UltraPlanError(
        "capability_not_available",
        `Section completion is a detail-stage operation (run is in ${run.stage})`,
        { stage: run.stage },
      );
    }
    if (run.activeWork?.type !== "section") {
      throw new UltraPlanError(
        "invalid_scope",
        `Section completion targets the active Section; run ${run.id} has no Section focus`,
        { activeWork: run.activeWork },
      );
    }
    const root = await this.store.getSection(run.id, run.activeWork.id);
    if (!root) {
      throw new UltraPlanError(
        "unknown_reference",
        `Active work ${run.activeWork.id} is not a committed Section of run ${run.id}`,
        { sectionID: run.activeWork.id },
      );
    }
    if (root.status !== "active") {
      throw new UltraPlanError(
        "invalid_scope",
        `Section completion requires an ACTIVE Section with an approved checkpoint (${root.id} is ${root.status}${root.currentRevision === undefined ? ", revisionless" : ""}) — a checkpoint is not a completion`,
        { sectionID: root.id, status: root.status },
      );
    }
    if (root.currentRevision === undefined || root.approvedRevision === undefined) {
      throw new UltraPlanError("revision_missing", `Section ${root.id} has no approved checkpoint revision`, {
        sectionID: root.id,
      });
    }
    if (root.currentRevision !== root.approvedRevision) {
      throw new UltraPlanError(
        "revision_mismatch",
        `Section ${root.id} pointers diverge (currentRevision ${root.currentRevision} != approvedRevision ${root.approvedRevision}); commit a checkpoint before completing`,
        { sectionID: root.id },
      );
    }
    // §9 dependency gate (the FROZEN rule) precedes the §10 validation gate —
    // both surface as precise blocker errors.
    const sections = await this.store.listSections(run.id);
    assertSectionCanComplete(sections, root.id);
    if (root.validation !== "valid") {
      throw new UltraPlanError(
        "section_needs_review",
        `Section ${root.id} is ${root.validation}; commit a revalidated checkpoint against the current dependency contracts before completing`,
        { sectionID: root.id, validation: root.validation },
      );
    }
    const revision = await this.store.getSectionRevision(run.id, {
      id: root.id,
      revision: root.approvedRevision,
    });
    if (!revision) {
      throw new UltraPlanError(
        "revision_missing",
        `Section revision ${root.id}@${root.approvedRevision} does not exist`,
        { sectionID: root.id, revision: root.approvedRevision },
      );
    }
    // §12 deterministic evidence reachability (freeze-side): target revision
    // → referenced committed decisions → their evidence refs.
    await this.assertCompletionEvidenceFresh(run.id, revision);
    return this.buildProposal(
      run,
      "section_completion",
      { type: "section", sectionID: root.id },
      `Complete ${root.id}@${root.approvedRevision}`,
      `Declare the current approved checkpoint ${root.id}@${root.approvedRevision} sufficiently complete to become a closed dependency. No design content is re-approved; the committed revision and its contract remain immutable.`,
      [{ kind: "complete_section", ref: { kind: "section", id: root.id, revision: root.approvedRevision } }],
    );
  }

  /**
   * §12: deterministic critical-evidence check along the only reachability
   * chain the domain currently represents — SectionRevision → referenced
   * committed Decisions → their Evidence refs. No repository scanning, no
   * speculative reachability.
   */
  private async assertCompletionEvidenceFresh(planID: PlanID, revision: SectionRevision): Promise<void> {
    for (const decisionID of revision.decisions) {
      const decision = await this.store.getDecision(planID, {
        id: decisionID,
        revision: (await this.store.listDecisions(planID)).find((d) => d.id === decisionID)?.revision ?? 1,
      });
      if (!decision) continue;
      for (const ref of decision.evidence ?? []) {
        const evidence = await this.store.getEvidence(planID, { id: ref.id });
        if (evidence && evidence.criticality === "critical" && !(evidence.status === "active" && evidence.freshness === "fresh")) {
          throw new UltraPlanError(
            "evidence_not_fresh",
            `Critical evidence ${evidence.id} (reachable from ${revision.sectionID}@${revision.revision} via ${decisionID}) is ${evidence.freshness}/${evidence.status}; completion blocked`,
            { evidenceID: evidence.id, decisionID },
          );
        }
      }
    }
  }

  /**
   * Phase 2E2 §20-§23: sanctioned workflow focus REQUEST. The model names a
   * target; the Harness validates deterministically and performs the durable
   * transition (expected-current-focus protected, `run.active_work_changed`
   * event). Not a Proposal, no user approval — activeWork is workflow state,
   * and the discussion order may run ahead of the completion order.
   */
  async requestSectionFocus(sessionID: string, input: SectionFocusInput): Promise<SynthesisRequestResult> {
    const run = requireRun(
      await this.authorizeTool(sessionID, "ultraplan_request_section_focus"),
      "request_section_focus",
    );
    if (run.stage !== "detail") {
      throw new UltraPlanError(
        "capability_not_available",
        `Section focus is a detail-stage operation (run is in ${run.stage})`,
        { stage: run.stage },
      );
    }
    if (typeof input.sectionID !== "string" || input.sectionID.trim().length === 0) {
      throw new UltraPlanError("invalid_scope", "A focus request requires a sectionID");
    }
    const sectionID = SectionIDs.cast(input.sectionID.trim());
    if (!run.sections.some((ref) => ref.id === sectionID)) {
      throw new UltraPlanError("unknown_reference", `Section ${sectionID} is not part of run ${run.id}`, {
        sectionID,
      });
    }
    const target = await this.store.getSection(run.id, sectionID);
    if (!target) {
      throw new UltraPlanError("unknown_reference", `Section ${sectionID} is not committed`, { sectionID });
    }
    if (target.status !== "pending" && target.status !== "active") {
      throw new UltraPlanError(
        "invalid_scope",
        `Focus cannot move to Section ${sectionID} in status ${target.status} (Phase 2E2 targets pending|active only)`,
        { sectionID, status: target.status },
      );
    }
    const next: WorkRef = { type: "section", id: sectionID };
    if (stableStringify(run.activeWork) === stableStringify(next)) {
      // Idempotent no-op: the requested section already has focus.
      return { run, statusText: await renderRunStatus(this.store, run) };
    }
    const updated = await this.store.transitionActiveWork(run.id, run.activeWork, next);
    return { run: updated, statusText: await renderRunStatus(this.store, updated) };
  }

  /**
   * Phase 2G §37-§50: the SANCTIONED reopen admission, restored narrowly.
   * The model names a target Section and — in synthesis — the findings it
   * acts on; the Harness resolves EVERYTHING authoritative (exact approved
   * revision, report binding, reason) and freezes an `amendment` Proposal
   * carrying the closed `reopen_section` change. `reopened` status is
   * committed artifact state: it is applied ONLY by the user-approved
   * PlanCommit (§39), never by this request.
   *
   * From synthesis (§41): the CURRENT ValidationReport must be `findings`,
   * the target must be approved with equal pointers, and at least one
   * selected finding must affect the exact target revision — an
   * Architecture-level finding cannot be mapped to an arbitrary Section
   * (§53, `reopen_target_unsupported`).
   * From detail (§49/§50): dependency_review — the target must be approved
   * AND needs_review; no report is required and findingIDs must be absent.
   */
  async requestReopen(sessionID: string, input: RequestReopenInput): Promise<PreparedProposal> {
    // Contextual authorization: detail section-ready substates and the
    // synthesis validation-findings substate grant request_reopen.
    const resolved = await this.authorizeTool(sessionID, "ultraplan_request_reopen");
    if (!resolved) {
      throw new UltraPlanError(
        "no_active_run",
        `Capability "request_reopen" requires an active PlanningRun; invoke /ultra-plan first`,
        { capability: "request_reopen" },
      );
    }
    const run = resolved;
    if (typeof input?.sectionID !== "string" || input.sectionID.trim().length === 0) {
      throw new UltraPlanError("invalid_scope", "A reopen request requires a sectionID");
    }
    const sectionID = SectionIDs.cast(input.sectionID.trim());
    if (!run.sections.some((ref) => ref.id === sectionID)) {
      throw new UltraPlanError("unknown_reference", `Section ${sectionID} is not part of run ${run.id}`, {
        sectionID,
      });
    }
    const root = await this.store.getSection(run.id, sectionID);
    if (!root) {
      throw new UltraPlanError("unknown_reference", `Section ${sectionID} is not committed`, { sectionID });
    }
    // Exact target resolution (§41): the Harness resolves the exact approved
    // revision — the model never supplies it, and pointers must agree.
    if (
      root.status !== "approved" ||
      root.currentRevision === undefined ||
      root.approvedRevision === undefined ||
      root.currentRevision !== root.approvedRevision
    ) {
      throw new UltraPlanError(
        "invalid_scope",
        `Section ${root.id} cannot be reopened: reopen targets an APPROVED Section whose current and approved revisions agree (status ${root.status}, current ${root.currentRevision ?? "none"}, approved ${root.approvedRevision ?? "none"})`,
        { sectionID: root.id, status: root.status },
      );
    }
    const targetRevision = root.approvedRevision;

    let reason: ReopenSectionReason;
    let findingsSummaries: { id: string; category: string; statement: string }[] | undefined;
    if (run.stage === "synthesis") {
      // -- semantic_validation reopen (§40/§41) --------------------------------
      if (!Array.isArray(input.findingIDs) || input.findingIDs.length === 0) {
        throw new UltraPlanError(
          "invalid_scope",
          "A synthesis-stage reopen requires findingIDs from the current semantic-validation report",
        );
      }
      const pair = await this.resolveCurrentSynthesisPair(run);
      const report =
        pair.input && pair.manifest
          ? await this.store.findValidationReportByIdentity(run.id, {
              inputHash: pair.input.hash,
              manifestHash: pair.manifest.hash,
              validatorProtocol: SEMANTIC_VALIDATION_PROTOCOL,
            })
          : undefined;
      if (!report) {
        throw new UltraPlanError(
          "validation_report_missing",
          `Run ${run.id} has no current semantic-validation report; request_semantic_validation first — a findings report is the only synthesis-side reopen authority`,
          { planID: run.id },
        );
      }
      if (report.result !== "findings") {
        throw new UltraPlanError(
          "reopen_reason_invalid",
          `${report.id} is clean; a clean report cannot authorize a reopen`,
          { reportID: report.id },
        );
      }
      const unknownFindings = input.findingIDs.filter(
        (raw) => !report.findings.some((finding) => finding.id === raw),
      );
      if (unknownFindings.length > 0) {
        throw new UltraPlanError(
          "unknown_reference",
          `Finding(s) ${unknownFindings.join(", ")} do not exist in ${report.id}`,
          { reportID: report.id },
        );
      }
      const affectsTarget = report.findings.some(
        (finding) =>
          input.findingIDs?.includes(finding.id) &&
          (finding.scope.sections ?? []).some(
            (scopeSection) => scopeSection.id === sectionID && scopeSection.revision === targetRevision,
          ),
      );
      if (!affectsTarget) {
        throw new UltraPlanError(
          "reopen_target_unsupported",
          `No selected finding of ${report.id} affects ${sectionID}@${targetRevision}; an Architecture-level finding cannot be falsely resolved through a Section reopen (architecture reopen remains unsupported)`,
          { reportID: report.id, sectionID, revision: targetRevision },
        );
      }
      reason = {
        type: "semantic_validation",
        reportID: report.id,
        reportHash: report.hash,
        findingIDs: input.findingIDs.map((raw) => ValidationFindingIDs.cast(raw)),
      };
      findingsSummaries = report.findings
        .filter((finding) => input.findingIDs?.includes(finding.id))
        .map((finding) => ({ id: finding.id, category: finding.category, statement: finding.statement }));
    } else if (run.stage === "detail") {
      // -- dependency_review reopen (§49/§50) ----------------------------------
      if (Array.isArray(input.findingIDs) && input.findingIDs.length > 0) {
        throw new UltraPlanError(
          "invalid_scope",
          "A detail-stage reopen is a dependency_review — findingIDs apply only to synthesis-stage semantic-validation reopens",
        );
      }
      if (root.validation !== "needs_review") {
        throw new UltraPlanError(
          "invalid_scope",
          `A dependency-review reopen requires the target to be validation=needs_review (${root.id} is ${root.validation}); Section ${root.id}@${targetRevision} is closed design and needs no review`,
          { sectionID: root.id, validation: root.validation },
        );
      }
      reason = { type: "dependency_review", validation: root.validation };
    } else {
      throw new UltraPlanError(
        "capability_not_available",
        `Reopen requests run in detail (dependency_review) or synthesis (semantic_validation); run is in ${run.stage}`,
        { stage: run.stage },
      );
    }

    const change: ProposalChange = {
      kind: "reopen_section",
      target: { id: sectionID, revision: targetRevision },
      reason,
      reopen: {
        sectionTitle: root.title,
        validation: "needs_review",
        fromStage: run.stage,
        ...(findingsSummaries ? { findings: findingsSummaries } : {}),
      },
    };
    if (!run.headSnapshot) {
      throw new UltraPlanError("invalid_scope", `Run ${run.id} has no HEAD snapshot to bind the proposal to`);
    }
    const proposal: Proposal = {
      id: ProposalIDs.from(
        nextSequence((await this.store.listProposals(run.id)).map((p) => p.id), ProposalIDs.prefix),
      ),
      type: "amendment",
      scope: { id: sectionID },
      revision: 1,
      status: "ready",
      title: `Reopen ${sectionID}`,
      summary:
        reason.type === "semantic_validation"
          ? `Reopen the approved design ${sectionID}@${targetRevision} for semantic-validation findings ${reason.findingIDs.join(", ")} (report ${reason.reportID}, hash ${reason.reportHash.slice(0, 16)}…). Effect: status approved → reopened, validation → needs_review${run.stage === "synthesis" ? ", stage synthesis → detail" : ""}, active work → ${sectionID}. No new revision is created and the approved revision stays immutable.`
          : `Reopen the approved but dependency-invalidated ${sectionID}@${targetRevision} for review against the current dependency contracts. Effect: status approved → reopened, active work → ${sectionID}. No new revision is created.`,
      changes: [change],
      dependencies: [],
      impact: { affectedSections: [sectionID], affectedDecisions: [] },
      createdFrom: { id: run.headSnapshot },
    };
    return this.freezeProposal(run, proposal);
  }

  // -- Phase 2G: read-only semantic validation (derived artifacts) ------------

  /**
   * Resolve the CURRENT validation pair (§11): the latest SynthesisInput
   * (must be non-stale) plus the latest manifest revision bound to it.
   * Deterministic errors; the model never selects the pair.
   */
  private async resolveCurrentSynthesisPair(
    run: PlanningRun,
  ): Promise<{ input: SynthesisInput; manifest: SynthesisManifest }> {
    const input = await this.store.getLatestSynthesisInput(run.id);
    if (!input) {
      throw new UltraPlanError(
        "synthesis_input_missing",
        `Run ${run.id} has no frozen SynthesisInput; freeze one with begin_synthesis first`,
        { planID: run.id },
      );
    }
    if (run.headSnapshot !== input.baseSnapshot.id) {
      throw new UltraPlanError(
        "synthesis_input_stale",
        `SynthesisInput ${input.id} is anchored to ${input.baseSnapshot.id}, but the run's HEAD is ${run.headSnapshot}; a stale input cannot be validated as current`,
        { inputID: input.id, baseSnapshot: input.baseSnapshot.id, headSnapshot: run.headSnapshot },
      );
    }
    const manifests = (await this.store.listSynthesisManifests(run.id)).filter(
      (manifest) => manifest.input.id === input.id,
    );
    if (manifests.length === 0) {
      throw new UltraPlanError(
        "synthesis_manifest_missing",
        `Run ${run.id} has no SynthesisManifest for input ${input.id}; submit one with submit_synthesis_manifest first`,
        { inputID: input.id },
      );
    }
    const manifest = manifests.reduce((latest, candidate) =>
      candidate.revision > latest.revision ? candidate : latest,
    );
    return { input, manifest };
  }

  /**
   * Phase 2G §6/§11/§12/§25-§26/§30-§31: run semantic validation of the exact
   * current (SynthesisInput, SynthesisManifest) pair through the ISOLATED
   * read-only validator. The model supplies NO report content (§6) — it only
   * requests the operation.
   *
   *   capability gate → resolve current pair (non-stale, exact manifest)
   *     → anti-laundering fast path (§25: same identity → existing report,
   *       validator NOT invoked)
   *     → lock: single-flight admission (§30/§31 — the lock is NOT held
   *       across the model call)
   *     → validator (unlocked) → strict parse (§17) → structural report
   *       validation (§23/§13)
   *     → lock: identity revalidated, report persisted immutably; a racing
   *       completed report wins (§64)
   *
   * An execution failure (validator unavailable, model error, parse/structure
   * rejection) persists NOTHING and stays retryable (§26) — it is never
   * converted into a findings report.
   */
  async runSemanticValidation(sessionID: string): Promise<RunSemanticValidationResult> {
    const resolved = await this.authorizeTool(sessionID, "ultraplan_run_semantic_validation");
    if (!resolved) {
      throw new UltraPlanError(
        "no_active_run",
        `Capability "run_semantic_validation" requires an active PlanningRun; invoke /ultra-plan first`,
        { capability: "run_semantic_validation" },
      );
    }
    const run = resolved;
    if (!this.semanticValidator) {
      // §10: fail honestly — no validator runtime is bound; never fake a result.
      throw new UltraPlanError(
        "validator_unavailable",
        "No semantic validator is bound to this controller; the Harness cannot execute semantic validation and will not fabricate a report",
      );
    }
    const { input, manifest } = await this.resolveCurrentSynthesisPair(run);
    // §12 preconditions recomputed here (defense beyond the store): hashes must
    // recompute and the manifest must mirror the input exactly.
    if (
      manifest.input.id !== input.id ||
      manifest.inputHash !== input.hash ||
      manifest.baseSnapshot.id !== input.baseSnapshot.id ||
      manifest.architecture.revision !== input.architecture.revision ||
      stableStringify(manifest.sections) !== stableStringify(input.sections)
    ) {
      throw new UltraPlanError(
        "invalid_scope",
        `Manifest ${manifest.id}@${manifest.revision} does not mirror the current input ${input.id}`,
        { manifestID: manifest.id, inputID: input.id },
      );
    }
    const identity: ValidationIdentity = {
      inputHash: input.hash,
      manifestHash: manifest.hash,
      validatorProtocol: SEMANTIC_VALIDATION_PROTOCOL,
    };
    const identityKey = validationIdentityKey(identity);

    // Anti-laundering fast path (§25): the exact identity already has its one
    // successful report — return it, never invoke the validator again (§66).
    const existing = await this.store.findValidationReportByIdentity(run.id, identity);
    if (existing) {
      return { report: existing, idempotent: true };
    }

    // Single-flight admission UNDER the lock (§30/§31); the model call runs
    // unlocked. A dead process's admission (different pid) is reclaimable.
    const admitted = await this.store.admitSemanticValidation(run.id, {
      ...identity,
      inputID: input.id,
      manifestID: manifest.id,
      manifestRevision: manifest.revision,
    }, { now: this.now(), ttlMs: 10 * 60 * 1000 });
    if (admitted.kind === "completed") {
      return { report: admitted.report, idempotent: true };
    }
    try {
      // -- Validator execution (no store lock held) ---------------------------
      const capsule = await buildValidationCapsule(this.store, input, manifest);
      const raw: RawValidatorOutput = await this.semanticValidator.validate(capsule);
      // -- Strict parsing (§17) + structural report validation (§23/§13) ------
      const draft = parseValidatorOutput(raw.text);
      validateValidatorOutput(draft, input, manifest);
      // -- Build the record: Harness assigns finding ids + report id + hash ---
      const reportID = ValidationReportIDs.from(
        nextSequence((await this.store.listValidationReports(run.id)).map((report) => report.id), ValidationReportIDs.prefix),
      );
      const findings = draft.findings.map((finding, index) => ({
        id: ValidationFindingIDs.from(index + 1),
        category: finding.category,
        statement: finding.statement,
        scope: finding.scope,
        ...(finding.manifestItem ? { manifestItem: finding.manifestItem } : {}),
        sources: finding.sources ?? [],
      }));
      const candidate: Omit<ValidationReport, "hash"> = {
        id: reportID,
        planID: run.id,
        input: { id: input.id },
        inputHash: input.hash,
        manifest: { id: manifest.id, revision: manifest.revision },
        manifestHash: manifest.hash,
        baseSnapshot: input.baseSnapshot,
        validatorProtocol: SEMANTIC_VALIDATION_PROTOCOL,
        ...(raw.model !== undefined ? { validatorModel: raw.model } : {}),
        result: draft.result,
        findings,
        createdAt: this.now(),
      };
      const { id: _id, createdAt: _createdAt, ...hashPayload } = candidate;
      void _id;
      void _createdAt;
      const report: ValidationReport = { ...candidate, hash: computeValidationReportHash(hashPayload) };
      // -- Persist under the lock: identity revalidated, races converge (§64) --
      const saved = await this.store.saveValidationReport(run.id, report);
      return { report: saved.report, idempotent: !saved.created };
    } finally {
      await this.store.releaseSemanticValidation(run.id, identityKey);
    }
  }

  // -- Phase 2H: deterministic finalization (Evidence Audit + gate + candidate) --

  /**
   * Phase 2H §45 — the ONE model-facing finalization operation. The model
   * supplies NOTHING (§4: no force/skip/ignore flags, no manifest/report
   * references — the Harness resolves every authoritative object):
   *
   *   resolve current identity → build/reuse the EvidenceAuditSnapshot
   *     (deterministic, no model call; blocked audits persist, §46)
   *   → evaluateFinalizationGate (pure; stale/blocker precedence per §28)
   *   ├── blocked/stale → exact machine reasons; NO candidate, NO stage
   *   │     transition, NO HEAD movement (§46/§47)
   *   └── pass → assemble + freeze the immutable FinalPlanCandidate
   *         (deterministic assembly §32; in-lock store revalidation §48 so a
   *         racing evidence write or live blocker fails finalization_stale)
   *
   * A passing candidate NEVER sets PlanningRun.finalPlan (§40), NEVER
   * transitions the stage (§76 — the synthesis → final edge belongs to the
   * Final PlanCommit), and NEVER moves HEAD (§42). Idempotent: the same
   * successful identity returns the same audit and candidate (§17/§38).
   */
  async requestFinalization(sessionID: string): Promise<RequestFinalizationResult> {
    const resolved = await this.authorizeTool(sessionID, "ultraplan_request_finalization");
    if (!resolved) {
      throw new UltraPlanError(
        "no_active_run",
        `Capability "request_finalization" requires an active PlanningRun; invoke /ultra-plan first`,
        { capability: "request_finalization" },
      );
    }
    const run = resolved;

    // Lenient resolution: every term is optional — the GATE classifies
    // whatever is missing (blocked) or superseded (stale). No throwing here.
    const snapshot = run.headSnapshot ? await this.store.getHeadSnapshot(run.id) : undefined;
    const input = await this.store.getLatestSynthesisInput(run.id);
    const manifests = input ? await this.store.listSynthesisManifests(run.id) : [];
    const manifest = input
      ? manifests
          .filter((candidate) => candidate.input.id === input.id)
          .reduce<SynthesisManifest | undefined>(
            (latest, candidate) => (latest === undefined || candidate.revision > latest.revision ? candidate : latest),
            undefined,
          )
      : undefined;
    const report =
      input && manifest
        ? ((await this.store.findValidationReportByIdentity(run.id, {
            inputHash: input.hash,
            manifestHash: manifest.hash,
            validatorProtocol: SEMANTIC_VALIDATION_PROTOCOL,
          })) ?? undefined)
        : undefined;

    // Build/reuse the Evidence Audit whenever the synthesis trio exists —
    // even for a state the gate will classify blocked (§46: a blocked audit
    // is the auditable explanation of the evidence term).
    let audit: EvidenceAuditSnapshot | undefined;
    if (snapshot && input && manifest && report) {
      const { hash: evidenceStateHash } = await computeCurrentEvidenceStateHash(this.store, run.id, snapshot);
      const auditIdentity: EvidenceAuditIdentity = {
        headSnapshot: snapshot.id,
        inputHash: input.hash,
        manifestHash: manifest.hash,
        reportHash: report.hash,
        evidenceStateHash,
      };
      audit =
        (await this.store.findEvidenceAuditByIdentity(run.id, auditIdentity)) ??
        (await this.buildAndSaveAudit(run, snapshot, input, manifest, report));
    }

    const gateDeps = await this.resolveGateDeps(run, audit, input, manifest, report);
    const gate = evaluateFinalizationGate(gateDeps);

    let candidate: RequestFinalizationResult["candidate"];
    if (gate.result === "pass" && input && manifest) {
      const draft = assembleFinalPlanCandidate({ identity: gate.identity, input, manifest });
      const saved = await this.store.saveFinalPlanCandidate(run.id, draft);
      candidate = {
        candidate: saved.candidate,
        idempotent: !saved.created,
        preview: renderFinalPlanCandidatePreview(saved.candidate),
      };
    }

    const savedRun = (await this.store.getRun(run.id)) ?? run;
    return {
      run: savedRun,
      gate,
      audit,
      ...(candidate ? { candidate } : {}),
      statusText: await renderRunStatus(this.store, savedRun),
    };
  }

  /** Build the audit for the exact current state and persist it (idempotent, §17). */
  private async buildAndSaveAudit(
    run: PlanningRun,
    snapshot: Snapshot,
    input: SynthesisInput,
    manifest: SynthesisManifest,
    report: ValidationReport,
  ): Promise<EvidenceAuditSnapshot> {
    const audit = await buildEvidenceAudit(
      this.store,
      { planID: run.id, snapshot, input, manifest, report },
      {
        id: EvidenceAuditIDs.from(
          nextSequence((await this.store.listEvidenceAudits(run.id)).map((entry) => entry.id), EvidenceAuditIDs.prefix),
        ),
        now: this.now(),
      },
    );
    const saved = await this.store.saveEvidenceAudit(run.id, audit);
    return saved.audit;
  }

  /**
   * Resolve the pure gate's inputs from the store: the exact HEAD snapshot,
   * the exact Architecture record, every snapshot Section root in canonical
   * order with its live root + exact approved revision, and the reachable
   * evidence fingerprint recomputed NOW (brief §26's mandatory re-check).
   */
  private async resolveGateDeps(
    run: PlanningRun,
    audit: EvidenceAuditSnapshot | undefined,
    input: SynthesisInput | undefined,
    manifest: SynthesisManifest | undefined,
    report: ValidationReport | undefined,
  ): Promise<FinalizationGateDeps> {
    const snapshot = run.headSnapshot ? ((await this.store.getHeadSnapshot(run.id)) ?? undefined) : undefined;
    const architecture = {
      ref: run.architecture,
      record:
        snapshot?.state.architectureRevision !== undefined
          ? ((await this.store.getArchitecture(run.id, snapshot.state.architectureRevision)) ?? undefined)
          : undefined,
    };
    const sections: ResolvedGateSection[] = [];
    for (const root of snapshot?.state.sectionRoots ?? []) {
      const live = (await this.store.getSection(run.id, root.id)) ?? undefined;
      const approvedRevision = root.approvedRevision ?? live?.approvedRevision ?? 0;
      const revisionRecord =
        approvedRevision > 0
          ? ((await this.store.getSectionRevision(run.id, { id: root.id, revision: approvedRevision })) ?? undefined)
          : undefined;
      sections.push({
        root,
        live,
        revision: { approvedRevision, record: revisionRecord },
      });
    }
    const currentEvidenceStateHash = snapshot
      ? (await computeCurrentEvidenceStateHash(this.store, run.id, snapshot)).hash
      : undefined;
    return { run, snapshot, architecture, sections, input, manifest, report, audit, currentEvidenceStateHash };
  }

  /**
   * The CURRENT synthesis trio (latest frozen input → its latest manifest →
   * the report bound to that exact identity). Shared by the finalization and
   * final-plan paths so the gate always classifies the same objects.
   */
  private async resolveSynthesisTrio(
    run: PlanningRun,
  ): Promise<{ input: SynthesisInput | undefined; manifest: SynthesisManifest | undefined; report: ValidationReport | undefined }> {
    const input = await this.store.getLatestSynthesisInput(run.id);
    const manifest = input
      ? (await this.store.listSynthesisManifests(run.id))
          .filter((candidate) => candidate.input.id === input.id)
          .reduce<SynthesisManifest | undefined>(
            (latest, candidate) => (latest === undefined || candidate.revision > latest.revision ? candidate : latest),
            undefined,
          )
      : undefined;
    const report =
      input && manifest
        ? ((await this.store.findValidationReportByIdentity(run.id, {
            inputHash: input.hash,
            manifestHash: manifest.hash,
            validatorProtocol: SEMANTIC_VALIDATION_PROTOCOL,
          })) ?? undefined)
        : undefined;
    return { input, manifest, report };
  }

  /** The audit bound to the CURRENT audited state (identity incl. live fingerprint), if any. */
  private async resolveCurrentAudit(
    run: PlanningRun,
    snapshot: Snapshot | undefined,
    input: SynthesisInput | undefined,
    manifest: SynthesisManifest | undefined,
    report: ValidationReport | undefined,
  ): Promise<EvidenceAuditSnapshot | undefined> {
    if (!snapshot || !input || !manifest || !report) return undefined;
    const { hash } = await computeCurrentEvidenceStateHash(this.store, run.id, snapshot);
    const current =
      (await this.store.findEvidenceAuditByIdentity(run.id, {
        headSnapshot: snapshot.id,
        inputHash: input.hash,
        manifestHash: manifest.hash,
        reportHash: report.hash,
        evidenceStateHash: hash,
      })) ?? undefined;
    if (current) return current;
    // Fallback: the newest audit. A drifted world must classify STALE (audit
    // bound to another authoritative state) rather than BLOCKED (audit
    // missing) — refusal either way, but the reason says re-resolve (2I §28).
    const family = await this.store.listEvidenceAudits(run.id);
    return family.length > 0 ? family[family.length - 1] : undefined;
  }

  /**
   * Phase 2I §57: BEFORE any user-facing confirmation, prove the Final
   * Proposal still binds the CURRENT candidate and the CURRENT passing gate
   * identity. A stale Final Proposal must never be user-presentable as current
   * authority — it is refused here (pre-ask), and even if it were presented,
   * the transaction engine independently reruns the gate at commit (§26).
   */
  private async assertFinalProposalCurrent(run: PlanningRun, proposal: Proposal): Promise<void> {
    const change = proposal.changes.find(
      (c): c is Extract<ProposalChange, { kind: "add_final_plan" }> => c.kind === "add_final_plan",
    );
    if (!change) {
      throw new UltraPlanError(
        "final_proposal_stale",
        `Final Proposal ${proposal.id} carries no add_final_plan change; it cannot be presented for approval`,
        { proposalID: proposal.id },
      );
    }
    const binding = change.finalPlan.finalPlanCandidate;
    const candidate = await this.store.getFinalPlanCandidate(run.id, FinalPlanCandidateIDs.cast(binding.id), binding.revision);
    if (!candidate || candidate.hash !== binding.hash) {
      throw new UltraPlanError(
        "final_proposal_stale",
        `Final Proposal ${proposal.id} binds FinalPlanCandidate ${binding.id}@${binding.revision}, which is not the stored candidate (or hashes differently); prepare a new Final Proposal from the current candidate`,
        { proposalID: proposal.id, candidateID: binding.id },
      );
    }
    const snapshot = run.headSnapshot ? ((await this.store.getHeadSnapshot(run.id)) ?? undefined) : undefined;
    const { input, manifest, report } = await this.resolveSynthesisTrio(run);
    const audit = await this.resolveCurrentAudit(run, snapshot, input, manifest, report);
    const gate = evaluateFinalizationGate(await this.resolveGateDeps(run, audit, input, manifest, report));
    if (gate.result === "stale") {
      throw new UltraPlanError(
        "finalization_stale",
        `The FinalizationGate is STALE; the state the user is being asked to approve has moved on (${gate.stale.map((entry) => entry.code).join(", ")})`,
        { stale: gate.stale },
      );
    }
    if (gate.result === "blocked") {
      throw new UltraPlanError(
        "finalization_blocked",
        `The FinalizationGate BLOCKS the Final Proposal (${gate.blockers.map((blocker) => blocker.code).join(", ")})`,
        { blockers: gate.blockers },
      );
    }
    if (!finalizationIdentityMatchesCandidate(gate.identity, candidate)) {
      throw new UltraPlanError(
        "final_proposal_stale",
        `The current gate identity differs from the Final Proposal's bound candidate ${candidate.id}@${candidate.revision}; the Proposal is stale — prepare a new one and obtain a NEW approval`,
        { proposalID: proposal.id, candidateID: candidate.id },
      );
    }
  }

  /**
   * Phase 2I §6-§10/§19: freeze the exact final_plan Proposal from the CURRENT
   * FinalPlanCandidate. The model supplies NOTHING; the Harness reruns the
   * deterministic Finalization Gate (never trusting "the candidate was valid
   * when created", §7), requires the exact candidate identity, projects the
   * FinalPlan through the shared buildFinalPlanFromCandidate (§33), Harness-
   * assigns FINAL-###@n (§9), and freezes the single add_final_plan change
   * (§16). No approval, no commit, no HEAD movement, no stage change — the run
   * stays synthesis/active while the user considers the Proposal (§3).
   */
  async prepareFinalPlan(sessionID: string): Promise<PrepareFinalPlanResult> {
    const resolved = await this.authorizeTool(sessionID, "ultraplan_prepare_final_plan");
    if (!resolved) {
      throw new UltraPlanError(
        "no_active_run",
        `Capability "prepare_final_plan" requires an active PlanningRun; invoke /ultra-plan first`,
        { capability: "prepare_final_plan" },
      );
    }
    const run = resolved;
    // §10: initial FinalPlan only — a committed FinalPlan exists (the run is
    // handoff-pending via the capability matrix; a hostile path is refused
    // deterministically here too).
    const committedPlans = await this.store.listFinalPlans(run.id);
    if (run.finalPlan !== undefined || committedPlans.length > 0) {
      throw new UltraPlanError(
        "final_plan_already_exists",
        `Run ${run.id} already has a committed FinalPlan; the final PlanCommit is once-per-run and amendment is a later workflow`,
        { planID: run.id },
      );
    }
    // §7: RERUN the gate — the candidate's past validity is not authority.
    const snapshot = run.headSnapshot ? ((await this.store.getHeadSnapshot(run.id)) ?? undefined) : undefined;
    const { input, manifest, report } = await this.resolveSynthesisTrio(run);
    const audit = await this.resolveCurrentAudit(run, snapshot, input, manifest, report);
    const gate = evaluateFinalizationGate(await this.resolveGateDeps(run, audit, input, manifest, report));
    if (gate.result === "stale") {
      throw new UltraPlanError(
        "finalization_stale",
        `Cannot prepare the Final Proposal: the FinalizationGate is STALE (${gate.stale.map((entry) => entry.code).join(", ")}); re-resolve from current state first`,
        { stale: gate.stale },
      );
    }
    if (gate.result === "blocked") {
      throw new UltraPlanError(
        "finalization_blocked",
        `Cannot prepare the Final Proposal: the FinalizationGate BLOCKS (${gate.blockers.map((blocker) => blocker.code).join(", ")})`,
        { blockers: gate.blockers },
      );
    }
    const identity = gate.identity;
    const candidate = await this.store.findFinalPlanCandidateByIdentity(run.id, {
      headSnapshot: identity.headSnapshot.id,
      inputHash: identity.synthesisInput.hash,
      manifestHash: identity.synthesisManifest.hash,
      reportHash: identity.validationReport.hash,
      auditHash: identity.evidenceAudit.hash,
    });
    if (!candidate) {
      throw new UltraPlanError(
        "finalization_stale",
        `No FinalPlanCandidate exists for the current passing gate identity; run ultraplan_request_finalization first (explicit request_finalization → current candidate → prepare_final_plan)`,
        { headSnapshot: identity.headSnapshot.id },
      );
    }
    const proposals = await this.store.listProposals(run.id);
    // §19 idempotency: the same current candidate reuses its existing
    // ready/awaiting Final Proposal. A rejected Proposal authorizes nothing
    // and is never resurrected — a NEW explicit preparation is allowed.
    for (const existing of proposals) {
      if (existing.type !== "final_plan" || (existing.status !== "ready" && existing.status !== "awaiting_approval")) {
        continue;
      }
      const existingChange = existing.changes.find(
        (c): c is Extract<ProposalChange, { kind: "add_final_plan" }> => c.kind === "add_final_plan",
      );
      if (!existingChange) continue;
      const binding = existingChange.finalPlan.finalPlanCandidate;
      if (binding.id === candidate.id && binding.revision === candidate.revision && binding.hash === candidate.hash) {
        return {
          proposal: existing,
          hash: existing.hash ?? computeProposalHash(existing),
          idempotent: true,
          preview: renderProposalForApproval(existing),
        };
      }
    }
    // §9: Harness-assigned FinalPlan identity, assigned BEFORE approval so the
    // user approves the exact resulting object (initial-only: FINAL-001@1).
    const finalPlanID = FinalPlanIDs.from(
      nextSequence((await this.store.listFinalPlans(run.id)).map((plan) => plan.id), FinalPlanIDs.prefix),
    );
    const content = buildFinalPlanFromCandidate({ candidate, assign: { id: finalPlanID, revision: 1 } });
    if (!run.headSnapshot) {
      throw new UltraPlanError("invalid_scope", `Run ${run.id} has no HEAD snapshot to bind the Final Proposal to`);
    }
    const proposal: Proposal = {
      id: ProposalIDs.from(nextSequence(proposals.map((entry) => entry.id), ProposalIDs.prefix)),
      type: "final_plan",
      // §17: the scope is the candidate's exact Architecture revision — never
      // an ambiguous "global latest".
      scope: { id: "ARCH", revision: candidate.architecture.revision },
      revision: 1,
      status: "ready",
      title: `Final Plan ${finalPlanID}@1`,
      summary: `Commits the exact FinalPlanCandidate ${candidate.id}@${candidate.revision} as immutable FinalPlan ${finalPlanID}@1. Effect: stage synthesis → final, lifecycle → handoff_pending. Build handoff is a later workflow.`,
      changes: [{ kind: "add_final_plan", finalPlan: content }],
      dependencies: [],
      // §16: the Final approval adds NO design — empty impact by construction.
      impact: { affectedSections: [], affectedDecisions: [] },
      createdFrom: { id: run.headSnapshot },
    };
    const frozen = await this.freezeProposal(run, proposal);
    return { proposal: frozen.proposal, hash: frozen.hash, idempotent: false, preview: renderProposalForApproval(frozen.proposal) };
  }

  // -- Phase 2J: recoverable ExecutionHandoff & same-session Build transition --

  /**
   * §29/§30/§57/§58: the deterministic execution role policy. The agent
   * defaults to the HOST-NATIVE Build agent (adapter configuration may
   * override; an explicitly-empty configuration means "configured but
   * unresolvable" and leaves the handoff pending). The model comes from
   * adapter configuration as "provider/model"; absent means the HOST DEFAULT
   * model — a host-supplied safe default (§57). The planning model is
   * deliberately never reused; there is no prompt-complexity routing (§59)
   * and the planning model never chooses the Build model.
   */
  private resolveExecutionPolicy(): { agent: string | undefined; model: { providerID: string; modelID: string } | undefined } {
    const bundle = this.executionRuntime;
    if (!bundle) {
      throw new UltraPlanError("execution_runtime_unavailable", "No execution runtime adapter is bound; the handoff cannot be dispatched");
    }
    let agent = bundle.executionAgent ?? "build";
    agent = agent.trim();
    if (!agent) {
      throw new UltraPlanError("execution_policy_unresolved", "Execution agent is configured but unresolvable; handoff remains pending");
    }
    let model: { providerID: string; modelID: string } | undefined;
    if (bundle.executionModel !== undefined) {
      const trimmed = bundle.executionModel.trim();
      if (!trimmed) {
        throw new UltraPlanError("execution_policy_unresolved", "Execution model is configured but unresolvable; handoff remains pending");
      }
      const separator = trimmed.indexOf("/");
      if (separator <= 0 || separator === trimmed.length - 1) {
        throw new UltraPlanError("execution_policy_unresolved", `Execution model "${trimmed}" is not a provider/model pair; handoff remains pending`);
      }
      model = { providerID: trimmed.slice(0, separator), modelID: trimmed.slice(separator + 1) };
    }
    return { agent, model };
  }

  /**
   * §76: the narrow HandoffCoordinator — recover handoff state, freeze the
   * handoff, resolve runtime policy, manage the dispatch admission, call the
   * runtime adapter (with NO store lock held across the host call, §40),
   * persist the receipt, complete the run. Fully reentrant (§77): every step
   * is idempotent against durable state. This is a recoverable side-effect
   * workflow — NOT another PlanCommit: no HEAD movement, no FinalPlan change,
   * and completion is a pure lifecycle transition (§46/§48).
   */
  async recoverExecutionHandoff(sessionID: string): Promise<HandoffRecoveryResult> {
    const run = await this.store.findLatestRunBySession(sessionID);
    if (!run) return { status: "not_applicable" };
    // §83/§94: completed is terminal — recovery is an idempotent no-op.
    if (run.lifecycle === "completed") return { status: "already_completed" };
    if (run.lifecycle !== "handoff_pending") return { status: "not_applicable" };
    if (!this.executionRuntime) {
      return { status: "blocked", code: "execution_runtime_unavailable", message: "No execution runtime adapter is bound; the handoff stays pending" };
    }
    // §17/§79: freeze (or reuse) the ONE canonical handoff from the exact
    // approved FinalPlan. Refuses a corrupted/incomplete final state.
    const finalPlan = run.finalPlan
      ? await this.store.getFinalPlan(run.id, run.finalPlan.id, run.finalPlan.revision)
      : undefined;
    if (!finalPlan || finalPlan.status !== "approved") {
      return { status: "blocked", code: "handoff_not_allowed", message: "The run's FinalPlan does not resolve as approved; refusing handoff" };
    }
    // §11: one EXACT canonical contract per exact approved SectionRevision,
    // resolved from committed Plan Memory, deduplicated, canonical order.
    const requiredContracts: import("../core/types.js").SectionContract[] = [];
    const seenContracts = new Set<string>();
    for (const ref of finalPlan.sections) {
      const revision = await this.store.getSectionRevision(run.id, ref);
      if (!revision) {
        return { status: "blocked", code: "handoff_not_allowed", message: `FinalPlan section ${ref.id}@${ref.revision} does not resolve; refusing handoff` };
      }
      const contract = revision.projection.contract;
      const key = `${contract.sectionID}@${contract.revision}`;
      if (!seenContracts.has(key)) {
        seenContracts.add(key);
        requiredContracts.push(contract);
      }
    }
    const assembled = assembleExecutionHandoff({
      run,
      finalPlan,
      requiredContracts,
      assign: { id: "HANDOFF-001", now: this.now() },
    });
    let handoff;
    try {
      handoff = (await this.store.saveExecutionHandoff(run.id, assembled.handoff)).handoff;
    } catch (error) {
      if (isUltraPlanError(error)) {
        return { status: "blocked", code: error.code, message: error.message };
      }
      throw error;
    }
    const handoffID = handoff.id;
    const deliveryKey = assembled.deliveryKey;
    const prepared = await this.store.prepareHandoffDelivery(run.id, {
      handoffID,
      handoffHash: handoff.hash,
      sessionID: run.sessionID,
      deliveryKey,
    });
    let delivery: HandoffDelivery = prepared.delivery;

    // §45/§82: delivered-but-not-completed crash window — complete, NO resend.
    if (delivery.state === "delivered" && delivery.hostReceipt) {
      await this.store.completeHandoffRun(run.id);
      return { status: "completed", handoffID, deliveryKey };
    }

    // §42/§43/§81/§92: stale dispatching — resolve ambiguity with HOST
    // evidence FIRST, never a blind resend.
    if (delivery.state === "dispatching") {
      const finder = this.executionRuntime.adapter.findHandoffDelivery;
      if (!finder) {
        return { status: "ambiguous", handoffID };
      }
      let receipt;
      try {
        receipt = await finder.call(this.executionRuntime.adapter, { sessionID: run.sessionID, deliveryKey });
      } catch {
        return { status: "ambiguous", handoffID };
      }
      if (receipt) {
        // Host definitely received it: record and complete (§43 step 3).
        await this.store.recordHandoffDelivered(run.id, handoffID, receipt);
        await this.store.completeHandoffRun(run.id);
        return { status: "completed", handoffID, deliveryKey };
      }
      // §43 step 5: a queryable host definitively shows no handoff — safe to
      // retry via the same deliveryKey.
      delivery = await this.store.reclaimHandoffDispatch(run.id, handoffID);
    }

    // §57/§58/§115: resolve the execution role policy — a failure leaves the
    // run handoff_pending with a deterministic error, never silently faked.
    let policy;
    try {
      policy = this.resolveExecutionPolicy();
    } catch (error) {
      if (isUltraPlanError(error)) {
        return { status: "blocked", code: error.code, message: error.message };
      }
      throw error;
    }
    // §38/§39/§41/§119: the single-flight dispatch admission. acquired=false
    // means another owner is dispatching (or already delivered).
    const admission = await this.store.beginHandoffDispatch(run.id, handoffID);
    if (!admission.acquired) {
      return { status: "in_flight", handoffID };
    }
    const prompt = renderExecutionHandoffPrompt(run.id, handoff, deliveryKey);
    try {
      // §40: NO store lock is held across this host call — each store
      // operation above/below takes its own lock; the adapter call runs
      // between them.
      await this.executionRuntime.adapter.dispatchHandoff({
        sessionID: run.sessionID,
        agent: policy.agent,
        model: policy.model,
        prompt,
        deliveryKey,
      });
    } catch (error) {
      if (error instanceof HandoffDispatchRejected) {
        // §61: definite rejection BEFORE acceptance — remains retryable.
        await this.store.reclaimHandoffDispatch(run.id, handoffID);
        return { status: "retryable_failure", handoffID, reason: error.message };
      }
      // §62: ambiguous — keep `dispatching`; recovery must query the host.
      return { status: "ambiguous", handoffID };
    }
    // §23: `delivered` requires observing the exact message in the host
    // session history — a bare acceptance is not enough.
    let receipt: HostDeliveryReceipt | undefined;
    try {
      receipt =
        (await this.executionRuntime.adapter.findHandoffDelivery?.({ sessionID: run.sessionID, deliveryKey })) ??
        undefined;
    } catch {
      receipt = undefined;
    }
    if (!receipt) {
      // §92: accepted-but-unconfirmed — recovery will query and complete.
      return { status: "ambiguous", handoffID };
    }
    await this.store.recordHandoffDelivered(run.id, handoffID, receipt);
    await this.store.completeHandoffRun(run.id);
    return { status: "completed", handoffID, deliveryKey };
  }

  /**
   * The guarded trigger for lifecycle hooks (§78): acts ONLY when a run for
   * this session is handoff_pending; all other states are a silent no-op.
   * Failures never throw — the delivery record and status carry them.
   */
  async maybeRecoverHandoff(sessionID: string): Promise<HandoffRecoveryResult | undefined> {
    try {
      const run = await this.store.findLatestRunBySession(sessionID);
      if (!run || run.lifecycle !== "handoff_pending") return undefined;
      return await this.recoverExecutionHandoff(sessionID);
    } catch {
      return undefined;
    }
  }

  // -- Approval admission bridge (Correction C: Harness-controlled) ----------
  //
  // These methods are NOT model tools and are NOT reachable from the tool
  // registry. They are the Harness-side entry points the Phase 2B approval UX
  // (built on verified structured user-interaction primitives) will call.

  /**
   * Atomically transition the exact frozen proposal `ready →
   * awaiting_approval` and produce the one-shot ApprovalRequest for the
   * structured user decision. Content cannot change during the transition and
   * the approval hash is unaffected (status is excluded from the payload).
   */
  async beginProposalApproval(sessionID: string, proposalID: string): Promise<BegunApproval> {
    const run = await this.store.findLatestRunBySession(sessionID);
    if (!run) throw new UltraPlanError("no_active_run", `No PlanningRun for session ${sessionID}`);
    const proposal = await this.store.getProposal(run.id, ProposalIDs.cast(proposalID));
    if (!proposal) {
      throw new UltraPlanError("unknown_reference", `Proposal ${proposalID} does not exist in run ${run.id}`);
    }
    if (proposal.status !== "ready") {
      throw new UltraPlanError(
        "proposal_not_approvable",
        `Proposal ${proposalID} is ${proposal.status}; only a ready proposal can enter approval`,
        { proposalID, status: proposal.status },
      );
    }
    // Phase 2I §20/§57: a Final Proposal is re-verified against the CURRENT
    // candidate + gate identity BEFORE the confirmation is presented. A stale
    // Final Proposal is never user-presentable as current authority.
    if (proposal.type === "final_plan") {
      await this.assertFinalProposalCurrent(run, proposal);
    }
    const awaiting = await this.store.transitionProposalStatus(
      run.id,
      proposal.id,
      "ready",
      "awaiting_approval",
    );
    const request: ApprovalRequest = {
      proposalID: awaiting.id,
      proposalRevision: awaiting.revision,
      proposalHash: awaiting.hash ?? "",
      oneShot: true,
      requestedAt: this.now(),
    };
    await this.store.appendEvent(run.id, {
      type: "proposal.awaiting_approval",
      proposalID: awaiting.id,
      proposalHash: awaiting.hash ?? "",
    });
    return { proposal: awaiting, request };
  }

  /**
   * Persist the immutable Approval for an awaiting proposal using the binding
   * captured in the Harness-created ApprovalRequest (never model-supplied
   * values). Idempotent: an exact duplicate returns the existing record.
   * The proposal STAYS awaiting_approval — only commitTransaction moves it to
   * approved (crash-safe approval persistence, Phase 2B1 brief §3).
   */
  async recordApproval(
    sessionID: string,
    proposalID: string,
    request: ApprovalRequest,
  ): Promise<{ approval: Approval; proposal: Proposal }> {
    const { run, proposal } = await this.awaitingProposal(sessionID, proposalID);
    // The decision binding comes from the Harness request object itself.
    const decision: UserApprovalDecision = {
      kind: "approved",
      proposalID: request.proposalID,
      proposalRevision: request.proposalRevision,
      proposalHash: request.proposalHash,
      actor: "user",
    };
    const outcome = applyApprovalDecision(proposal, request, decision, this.now());
    if (outcome.kind !== "approved") {
      throw new UltraPlanError("approval_mismatch", "Unexpected rejection outcome in recordApproval");
    }
    const existing = await this.store.findApprovalForProposal(run.id, proposal.id);
    if (existing) return { approval: existing, proposal };
    // Harness assigns the authoritative approval id from the store sequence.
    const sequence = nextSequence(
      (await this.store.listApprovals(run.id)).map((a) => a.id),
      ApprovalIDs.prefix,
    );
    const approval = await this.store.saveApproval(run.id, {
      ...outcome.approval,
      id: ApprovalIDs.from(sequence),
    });
    return { approval, proposal };
  }

  /**
   * Run the transaction engine for an approved proposal. Deterministic and
   * idempotent (the store returns the existing PlanCommit on exact retry).
   */
  async commitApprovedProposal(
    sessionID: string,
    proposalID: string,
  ): Promise<CommitResult> {
    const run = await this.store.findLatestRunBySession(sessionID);
    if (!run) throw new UltraPlanError("no_active_run", `No PlanningRun for session ${sessionID}`);
    const proposalIDBranded = ProposalIDs.cast(proposalID);
    const approval = await this.store.findApprovalForProposal(run.id, proposalIDBranded);
    if (!approval) {
      throw new UltraPlanError(
        "approval_not_found",
        `Proposal ${proposalID} has no recorded user approval; approval must be recorded before commit`,
        { proposalID },
      );
    }
    const commit = await this.store.commitTransaction({
      planID: run.id,
      proposalID: proposalIDBranded,
      approvalID: approval.id,
    });
    const [committed, snapshot, currentRun] = await Promise.all([
      this.store.getProposal(run.id, proposalIDBranded),
      this.store.getHeadSnapshot(run.id),
      this.store.getRun(run.id),
    ]);
    return {
      commit,
      proposal: committed,
      snapshot,
      run: currentRun,
    };
  }

  /**
   * Approval gateway orchestration: persist the approval, then run the
   * transaction. Rejection is a separate explicit path (rejectProposal).
   */
  async recordApprovalAndCommit(
    sessionID: string,
    proposalID: string,
    request: ApprovalRequest,
  ): Promise<CommitResult> {
    await this.recordApproval(sessionID, proposalID, request);
    return this.commitApprovedProposal(sessionID, proposalID);
  }

  /**
   * Structured user rejection: awaiting_approval → rejected. Creates no
   * Approval authorization, no PlanCommit, no committed mutation, no HEAD
   * movement — and appends a proposal.rejected event.
   */
  async rejectProposal(sessionID: string, proposalID: string, request: ApprovalRequest): Promise<Proposal> {
    const { run, proposal } = await this.awaitingProposal(sessionID, proposalID);
    const decision: UserApprovalDecision = {
      kind: "rejected",
      proposalID: request.proposalID,
      proposalRevision: request.proposalRevision,
      proposalHash: request.proposalHash,
      actor: "user",
    };
    applyApprovalDecision(proposal, request, decision, this.now());
    const rejected = await this.store.transitionProposalStatus(
      run.id,
      proposal.id,
      "awaiting_approval",
      "rejected",
    );
    await this.store.appendEvent(run.id, { type: "proposal.rejected", proposalID: rejected.id });
    return rejected;
  }

  private async awaitingProposal(
    sessionID: string,
    proposalID: string,
  ): Promise<{ run: PlanningRun; proposal: Proposal }> {
    const run = await this.store.findLatestRunBySession(sessionID);
    if (!run) throw new UltraPlanError("no_active_run", `No PlanningRun for session ${sessionID}`);
    const proposal = await this.store.getProposal(run.id, ProposalIDs.cast(proposalID));
    if (!proposal) {
      throw new UltraPlanError("unknown_reference", `Proposal ${proposalID} does not exist in run ${run.id}`);
    }
    return { run, proposal };
  }

  /**
   * Validate a structured user decision against the awaiting proposal and the
   * outstanding request. Binding mismatches fail with `approval_mismatch`.
   * The validated outcome (Approval record / rejection) is what the Phase 2B
   * engine will persist and commit against.
   */
  async applyProposalDecision(
    sessionID: string,
    proposalID: string,
    request: ApprovalRequest,
    decision: UserApprovalDecision,
  ): Promise<ReturnType<typeof applyApprovalDecision>> {
    const run = await this.store.findLatestRunBySession(sessionID);
    if (!run) throw new UltraPlanError("no_active_run", `No PlanningRun for session ${sessionID}`);
    const proposal = await this.store.getProposal(run.id, ProposalIDs.cast(proposalID));
    if (!proposal) {
      throw new UltraPlanError("unknown_reference", `Proposal ${proposalID} does not exist in run ${run.id}`);
    }
    return applyApprovalDecision(proposal, request, decision, this.now());
  }

  // -- Synthesis / finalization gate --------------------------------------------

  async requestSynthesis(sessionID: string): Promise<SynthesisRequestResult> {
    // Phase 2H §55: request_synthesis is granted NOWHERE and this method can
    // only be reached by hostile/direct callers. It delegates to the ONE
    // finalization authority (the deterministic Evidence Audit + gate) purely
    // so no second predicate exists, and it can NEVER transition the stage:
    // the real pipeline is Manifest → Semantic Validation → Evidence Audit →
    // Finalization Gate → FinalPlanCandidate, and the synthesis → final edge
    // belongs to the Final PlanCommit (a later phase) — never this shortcut.
    const run = requireRun(await this.authorizeTool(sessionID, "ultraplan_request_synthesis"), "request_synthesis");
    const snapshot = run.headSnapshot ? ((await this.store.getHeadSnapshot(run.id)) ?? undefined) : undefined;
    const input = await this.store.getLatestSynthesisInput(run.id);
    const manifest = input
      ? (await this.store.listSynthesisManifests(run.id))
          .filter((candidate) => candidate.input.id === input.id)
          .reduce<SynthesisManifest | undefined>(
            (latest, candidate) => (latest === undefined || candidate.revision > latest.revision ? candidate : latest),
            undefined,
          )
      : undefined;
    const report =
      input && manifest
        ? ((await this.store.findValidationReportByIdentity(run.id, {
            inputHash: input.hash,
            manifestHash: manifest.hash,
            validatorProtocol: SEMANTIC_VALIDATION_PROTOCOL,
          })) ?? undefined)
        : undefined;
    const audit =
      snapshot && input && manifest && report
        ? await this.buildAndSaveAudit(run, snapshot, input, manifest, report)
        : undefined;
    const gate = evaluateFinalizationGate(await this.resolveGateDeps(run, audit, input, manifest, report));
    throw new UltraPlanError(
      "finalization_blocked",
      gate.result === "pass"
        ? `The provisional synthesis→final shortcut is retired: the finalization gate PASSES, but finalization is expressed as a FinalPlanCandidate (ultraplan_request_finalization) and the synthesis→final transition belongs to the Final PlanCommit — request_synthesis can never move the stage`
        : `The provisional synthesis→final shortcut is retired and the finalization gate does not pass (${gate.result === "blocked" ? gate.blockers.map((blocker) => blocker.code).join(", ") : gate.stale.map((entry) => entry.code).join(", ")}); use the real pipeline: begin_synthesis → submit_synthesis_manifest → run_semantic_validation → request_finalization`,
      gate.result === "blocked"
        ? { gate: "blocked", blockers: gate.blockers }
        : gate.result === "stale"
          ? { gate: "stale", stale: gate.stale }
          : { gate: "pass" },
    );
  }

  // -- Phase 2F: the real Synthesis workflow (derived artifacts) -----------------

  /**
   * Phase 2F §20/§7/§8: freeze the HEAD-anchored SynthesisInput. The model
   * supplies NO authoritative refs — the Harness validates the structural
   * entry gates, resolves every exact ref from the HEAD Snapshot, freezes the
   * canonical payload (store-assigned id/hash), and returns the immutable
   * input identity plus the deterministic synthesis capsule. Idempotent: a
   * repeated freeze at the same authoritative state returns the SAME input
   * (§17). Creating an input never changes stage, never creates a PlanCommit,
   * and never moves HEAD (§44/§49).
   */
  async beginSynthesis(sessionID: string): Promise<BeginSynthesisResult> {
    // authorizeTool performs the CONTEXTUAL capability assertion (the
    // synthesis substate derives from the latest artifacts); a redundant
    // contextless requireRun here would resolve the no-input substate and
    // wrongly deny submit-capable states (the Phase 2E2 lesson).
    const resolved = await this.authorizeTool(sessionID, "ultraplan_begin_synthesis");
    if (!resolved) {
      throw new UltraPlanError(
        "no_active_run",
        `Capability "begin_synthesis" requires an active PlanningRun; invoke /ultra-plan first`,
        { capability: "begin_synthesis" },
      );
    }
    const run = resolved;
    // Structural entry gates beyond the capability gate (defense + precise
    // errors; §8). Deliberately does NOT consult blocking questions/conflicts
    // and performs NO finalization/final-stage transition.
    const snapshot = await assertSynthesisEntryReady(this.store, run);
    const payload = await buildSynthesisAuthorityPayload(this.store, run, snapshot);
    const input = await this.store.freezeSynthesisInput(run.id, payload);
    return { input, capsule: await renderSynthesisCapsule(this.store, input) };
  }

  /**
   * Phase 2F §24/§33: submit derived synthesis output as the next immutable
   * SynthesisManifest revision. The model supplies ONLY derived content; the
   * Harness resolves the CURRENT frozen input (exact, non-stale), brands every
   * source ref, validates structure (provenance, cross-section rule,
   * coverage, Section-DAG order, finding categories) deterministically, and
   * lets the store assign identity/revision/hash with exact-resubmission
   * idempotency (§36/§37). Submission creates NO PlanCommit, moves HEAD
   * nowhere, and leaves the stage at synthesis (§23/§44/§49).
   */
  async submitSynthesisManifest(
    sessionID: string,
    draft: SynthesisManifestDraftInput,
  ): Promise<SubmitSynthesisManifestResult> {
    // Contextual authorization (see beginSynthesis — no contextless re-assert).
    const resolved = await this.authorizeTool(sessionID, "ultraplan_submit_synthesis_manifest");
    if (!resolved) {
      throw new UltraPlanError(
        "no_active_run",
        `Capability "submit_synthesis_manifest" requires an active PlanningRun; invoke /ultra-plan first`,
        { capability: "submit_synthesis_manifest" },
      );
    }
    const run = resolved;
    const input = await this.store.getLatestSynthesisInput(run.id);
    if (!input) {
      throw new UltraPlanError(
        "synthesis_input_missing",
        `Run ${run.id} has no frozen SynthesisInput; freeze one with begin_synthesis first`,
        { planID: run.id },
      );
    }
    // §18/§50: a stale input stays readable but accepts no new current manifest.
    if (run.headSnapshot !== input.baseSnapshot.id) {
      throw new UltraPlanError(
        "synthesis_input_stale",
        `SynthesisInput ${input.id} is anchored to ${input.baseSnapshot.id}, but the run's HEAD is ${run.headSnapshot}; the stale input remains readable but accepts no new manifest`,
        { inputID: input.id, baseSnapshot: input.baseSnapshot.id, headSnapshot: run.headSnapshot },
      );
    }
    const typed = this.parseSynthesisManifestDraft(draft);
    validateManifestDraft(typed, input, {
      questions: run.openQuestions,
      conflicts: run.conflicts,
    });
    // §37 idempotency signal: hashes bound to this input BEFORE the save; if
    // the store returned one of them, the exact content already existed.
    const knownHashes = new Set(
      (await this.store.listSynthesisManifests(run.id))
        .filter((existing) => existing.input.id === input.id)
        .map((existing) => existing.hash),
    );
    const manifest = await this.store.saveSynthesisManifest(run.id, { ...typed, inputID: input.id });
    return { manifest, idempotent: knownHashes.has(manifest.hash) };
  }

  /**
   * Parse + brand the flattened manifest draft (closed transport contract).
   * Shape errors are precise `invalid_scope`; source refs are validated for
   * exactness (required revisions present) — their RESOLUTION against the
   * frozen input happens in validateManifestDraft.
   */
  private parseSynthesisManifestDraft(draft: SynthesisManifestDraftInput): Omit<import("../synthesis/types.js").SynthesisManifestDraft, "inputID"> {
    const sourceRef = (raw: SynthesisSourceRefInput, what: string): SynthesisSourceRef => {
      if (!raw || typeof raw !== "object") {
        throw new UltraPlanError("invalid_scope", `${what} requires a source ref object`);
      }
      if (raw.kind === "architecture") return { kind: "architecture" };
      if (!raw.id || typeof raw.id !== "string" || raw.id.trim().length === 0) {
        throw new UltraPlanError("invalid_scope", `${what} source ref requires an id`);
      }
      const id = raw.id.trim();
      switch (raw.kind) {
        case "section":
          if (typeof raw.revision !== "number" || !Number.isInteger(raw.revision) || raw.revision < 1) {
            throw new UltraPlanError("invalid_scope", `${what} section source ${id} requires an exact revision`);
          }
          return { kind: "section", id: SectionIDs.cast(id), revision: raw.revision };
        case "decision":
          if (typeof raw.revision !== "number" || !Number.isInteger(raw.revision) || raw.revision < 1) {
            throw new UltraPlanError("invalid_scope", `${what} decision source ${id} requires an exact revision`);
          }
          return { kind: "decision", id: DecisionIDs.cast(id), revision: raw.revision };
        case "evidence":
          if (typeof raw.revision !== "number" || !Number.isInteger(raw.revision) || raw.revision < 1) {
            throw new UltraPlanError("invalid_scope", `${what} evidence source ${id} requires an exact revision`);
          }
          return { kind: "evidence", id: EvidenceIDs.cast(id), revision: raw.revision };
        case "constraint":
          return { kind: "constraint", id: ConstraintIDs.cast(id) };
        case "question":
          return { kind: "question", id: QuestionIDs.cast(id) };
        case "conflict":
          return { kind: "conflict", id: ConflictIDs.cast(id) };
        default:
          throw new UltraPlanError("invalid_scope", `${what} carries an unsupported source ref kind`);
      }
    };
    const derivedStatements = (
      statements: { statement: string; sources: SynthesisSourceRefInput[] }[] | undefined,
      what: string,
    ) => {
      if (!Array.isArray(statements)) {
        throw new UltraPlanError("invalid_scope", `A manifest draft requires a ${what} array`);
      }
      return statements.map((statement, index) => {
        if (typeof statement?.statement !== "string" || statement.statement.trim().length === 0) {
          throw new UltraPlanError("invalid_scope", `${what}[${index}] requires a non-empty statement`);
        }
        if (!Array.isArray(statement.sources)) {
          throw new UltraPlanError("invalid_scope", `${what}[${index}] requires a sources array`);
        }
        return {
          statement: statement.statement,
          sources: statement.sources.map((source, sourceIndex) =>
            sourceRef(source, `${what}[${index}].sources[${sourceIndex}]`),
          ),
        };
      });
    };

    if (!Array.isArray(draft?.implementationOrder)) {
      throw new UltraPlanError("invalid_scope", "A manifest draft requires an implementationOrder array");
    }
    const implementationOrder = draft.implementationOrder.map((step, index) => {
      if (typeof step?.title !== "string" || step.title.trim().length === 0) {
        throw new UltraPlanError("invalid_scope", `implementationOrder[${index}] requires a non-empty title`);
      }
      if (typeof step?.description !== "string" || step.description.trim().length === 0) {
        throw new UltraPlanError("invalid_scope", `implementationOrder[${index}] requires a non-empty description`);
      }
      if (!Array.isArray(step?.sections) || !Array.isArray(step?.sources)) {
        throw new UltraPlanError("invalid_scope", `implementationOrder[${index}] requires sections and sources arrays`);
      }
      return {
        title: step.title,
        description: step.description,
        sections: step.sections.map((sectionRef, sectionIndex) => {
          if (typeof sectionRef?.id !== "string" || sectionRef.id.trim().length === 0) {
            throw new UltraPlanError("invalid_scope", `implementationOrder[${index}].sections[${sectionIndex}] requires a section id`);
          }
          if (typeof sectionRef?.revision !== "number" || !Number.isInteger(sectionRef.revision) || sectionRef.revision < 1) {
            throw new UltraPlanError("invalid_scope", `implementationOrder[${index}].sections[${sectionIndex}] requires an exact revision`);
          }
          return { id: SectionIDs.cast(sectionRef.id.trim()), revision: sectionRef.revision };
        }),
        sources: step.sources.map((source, sourceIndex) =>
          sourceRef(source, `implementationOrder[${index}].sources[${sourceIndex}]`),
        ),
      };
    });

    if (!Array.isArray(draft?.unresolvedFindings)) {
      throw new UltraPlanError("invalid_scope", "A manifest draft requires an unresolvedFindings array");
    }
    const unresolvedFindings = draft.unresolvedFindings.map((finding, index) => {
      if (typeof finding?.statement !== "string" || finding.statement.trim().length === 0) {
        throw new UltraPlanError("invalid_scope", `unresolvedFindings[${index}] requires a non-empty statement`);
      }
      // The category vocabulary is owned by the structural validator
      // (finding_invalid) so the deterministic code is stable at both layers.
      return {
        category: finding?.category as (typeof SYNTHESIS_FINDING_CATEGORIES)[number],
        statement: finding.statement,
        ...(Array.isArray(finding.sources)
          ? { sources: finding.sources.map((source, sourceIndex) => sourceRef(source, `unresolvedFindings[${index}].sources[${sourceIndex}]`)) }
          : {}),
      };
    });

    return {
      crossSectionLinks: derivedStatements(draft?.crossSectionLinks, "crossSectionLinks"),
      implementationOrder,
      limitations: derivedStatements(draft?.limitations, "limitations"),
      unresolvedFindings,
    };
  }

  // -- Helpers -------------------------------------------------------------------

  private async questionScope(
    run: PlanningRun,
    input: QuestionScopeInput,
  ): Promise<OpenQuestion["scope"]> {
    if (input.type === "architecture") {
      const architecture = await this.store.getArchitecture(run.id);
      return { id: "ARCH", revision: architecture?.revision ?? 1 };
    }
    if (!input.sectionID) {
      throw new UltraPlanError("invalid_scope", "Section-scoped questions require a sectionID");
    }
    const sectionID = SectionIDs.cast(input.sectionID);
    if (!run.sections.some((ref) => ref.id === sectionID)) {
      throw new UltraPlanError("invalid_scope", `Section ${sectionID} is not part of run ${run.id}`);
    }
    return { id: sectionID };
  }

  private async assertRefResolves(run: PlanningRun, ref: MemoryRef): Promise<void> {
    if (ref.kind === "section" && ref.id && !run.sections.some((existing) => existing.id === ref.id)) {
      throw new UltraPlanError("unknown_reference", `Section ${ref.id} is not part of run ${run.id}`);
    }
    if (ref.kind === "question" && ref.id && !run.openQuestions.some((q) => q.id === ref.id)) {
      throw new UltraPlanError("unknown_reference", `Question ${ref.id} does not exist in run ${run.id}`);
    }
    if (ref.kind === "conflict" && ref.id && !run.conflicts.some((c) => c.id === ref.id)) {
      throw new UltraPlanError("unknown_reference", `Conflict ${ref.id} does not exist in run ${run.id}`);
    }
    if (
      ref.kind === "decision" &&
      ref.id &&
      !run.decisions.some((existing) => existing.id === ref.id)
    ) {
      throw new UltraPlanError(
        "unknown_reference",
        `Decision ${ref.id} is not part of run ${run.id} (committed decisions appear once the transaction engine lands)`,
      );
    }
  }

  /**
   * Freeze-time change resolution: turn a working draft into the exact typed
   * committed intent the user will approve. Harness assigns ids/revision
   * numbers here; targets must resolve NOW (no HEAD-relative ambiguity).
   * `context.plannedArchitectureRevision` carries the revision an
   * `add_architecture` earlier in the SAME proposal will create, so a paired
   * `complete_architecture` can bind to it without HEAD-relative ambiguity.
   */
  private async resolveChange(
    run: PlanningRun,
    change: PreparedChange,
    context: {
      plannedArchitectureRevision?: number;
      /** Ids assigned to add_decision changes EARLIER in this same proposal. */
      plannedDecisionIds?: ReadonlySet<DecisionID>;
      /** The exact question objects raised EARLIER in this same proposal. */
      plannedQuestions?: readonly OpenQuestion[];
    } = {},
  ): Promise<{ change: ProposalChange; affectedDecision?: DecisionID; affectedSection?: SectionID }> {
    const now = this.now();
    switch (change.kind) {
      case "add_decision": {
        const draft = readDecisionDraft(change.content);
        const id = DecisionIDs.from(
          nextSequence((await this.store.listDecisions(run.id)).map((d) => d.id), DecisionIDs.prefix),
        );
        const decision: ApprovedDecision = {
          id,
          revision: 1,
          status: "approved",
          approvedAt: now,
          title: draft.title,
          statement: draft.statement,
          rationale: draft.rationale,
          ...(draft.alternatives ? { alternatives: draft.alternatives } : {}),
          ...(draft.consequences ? { consequences: draft.consequences } : {}),
          scope: draft.scope ?? {},
          ...(draft.evidence ? { evidence: draft.evidence } : {}),
        };
        return { change: { kind: "add_decision", decision }, affectedDecision: id };
      }
      case "amend_decision": {
        if (!change.ref?.id || change.ref.revision === undefined) {
          throw new UltraPlanError(
            "invalid_scope",
            "amend_decision requires an exact decision ref (id + revision) — no HEAD-relative ambiguity",
          );
        }
        const target = await this.store.getDecision(run.id, {
          id: DecisionIDs.cast(change.ref.id),
          revision: change.ref.revision,
        });
        if (!target) {
          throw new UltraPlanError(
            "unknown_reference",
            `Amend target ${change.ref.id}@${change.ref.revision} does not exist`,
          );
        }
        const draft = readDecisionDraft(change.content);
        const decision: ApprovedDecision = {
          id: target.id,
          revision: target.revision + 1,
          status: "approved",
          approvedAt: now,
          supersedes: { id: target.id, revision: target.revision },
          title: draft.title,
          statement: draft.statement,
          rationale: draft.rationale,
          ...(draft.alternatives ? { alternatives: draft.alternatives } : {}),
          ...(draft.consequences ? { consequences: draft.consequences } : {}),
          scope: draft.scope ?? target.scope,
          ...(draft.evidence ? { evidence: draft.evidence } : target.evidence ? { evidence: target.evidence } : {}),
        };
        return {
          change: { kind: "amend_decision", supersedes: { id: target.id, revision: target.revision }, decision },
          affectedDecision: target.id,
        };
      }
      case "amend_section": {
        if (!change.ref?.id || change.ref.revision === undefined) {
          throw new UltraPlanError(
            "invalid_scope",
            "amend_section requires an exact section revision ref (id + revision)",
          );
        }
        const target = await this.store.getSectionRevision(run.id, {
          id: SectionIDs.cast(change.ref.id),
          revision: change.ref.revision,
        });
        if (!target) {
          throw new UltraPlanError(
            "unknown_reference",
            `Amend target ${change.ref.id}@${change.ref.revision} does not exist`,
          );
        }
        const draft = readSectionRevisionDraft(change.content);
        const revisionNumber = target.revision + 1;
        const revision: ApprovedSectionRevision = {
          sectionID: target.sectionID,
          revision: revisionNumber,
          status: "approved",
          createdAt: now,
          problem: draft.problem,
          design: draft.design,
          interfaces: draft.interfaces ?? [],
          invariants: draft.invariants ?? [],
          failureModes: draft.failureModes ?? [],
          dependencies: draft.dependencies ?? [],
          decisions: draft.decisions ?? [],
          openQuestions: draft.openQuestions ?? [],
          impacts: draft.impacts ?? [],
          projection: {
            compact: draft.compactProjection,
            contract: {
              sectionID: target.sectionID,
              revision: revisionNumber,
              provides: draft.contract.provides,
              requires: draft.contract.requires,
              invariants: draft.contract.invariants,
              interfaces: draft.contract.interfaces,
              decisions: draft.contract.decisions,
            },
          },
        };
        return {
          change: { kind: "amend_section", supersedes: { id: target.sectionID, revision: target.revision }, revision },
          affectedSection: target.sectionID,
        };
      }
      case "add_architecture": {
        const existing = await this.store.getArchitecture(run.id);
        if (existing) {
          throw new UltraPlanError(
            "invalid_scope",
            `Architecture ARCH@${existing.revision} is already committed; add_architecture is the INITIAL path and never replaces a committed Architecture`,
            { architectureID: "ARCH", revision: existing.revision },
          );
        }
        const draft = readArchitectureDraft(change.content);
        // Resolve every reference against real run state NOW — the frozen
        // Architecture must not carry dangling ids. Same-proposal references
        // resolve to changes EARLIER in the changes array (mirroring the
        // engine's staged application order).
        const unresolved: OpenQuestion[] = [];
        for (const id of draft.unresolvedQuestionIDs ?? []) {
          const question =
            run.openQuestions.find((q) => q.id === id) ??
            context.plannedQuestions?.find((q) => q.id === id);
          if (!question) {
            throw new UltraPlanError(
              "unknown_reference",
              `Unresolved question ${id} does not exist in run ${run.id}; record or raise it earlier in this proposal first`,
            );
          }
          unresolved.push(question);
        }
        const committedDecisions = await this.store.listDecisions(run.id);
        const basedOn: DecisionID[] = [];
        for (const id of draft.basedOn ?? []) {
          if (!committedDecisions.some((decision) => decision.id === id) && !context.plannedDecisionIds?.has(id)) {
            throw new UltraPlanError(
              "unknown_reference",
              `Decision ${id} is not committed; basedOn must reference committed decisions or add_decision changes earlier in this proposal`,
            );
          }
          basedOn.push(id);
        }
        const architecture: ApprovedArchitecture = {
          id: "ARCH",
          revision: 1,
          status: "approved",
          summary: draft.summary,
          components: draft.components,
          boundaries: draft.boundaries,
          dataFlows: draft.dataFlows,
          principles: draft.principles,
          unresolved,
          basedOn,
        };
        return { change: { kind: "add_architecture", architecture } };
      }
      case "add_constraint": {
        const draft = readConstraintDraft(change.content);
        if (run.constraints.some((c) => c.status === "active" && c.statement === draft.statement)) {
          throw new UltraPlanError(
            "proposal_kind_unsupported",
            `An identical active constraint is already committed: "${draft.statement}" — add_constraint must not duplicate`,
          );
        }
        const id = ConstraintIDs.from(nextSequence(run.constraints.map((c) => c.id), ConstraintIDs.prefix));
        const constraint: ApprovedConstraint = {
          id,
          source: draft.source,
          statement: draft.statement,
          severity: draft.severity,
          status: "active",
        };
        return { change: { kind: "add_constraint", constraint } };
      }
      case "raise_question": {
        const draft = readRaiseQuestionDraft(change.content);
        if (run.openQuestions.some((q) => q.question === draft.question)) {
          throw new UltraPlanError(
            "proposal_kind_unsupported",
            `An identical question is already recorded: "${draft.question}" — raise_question must not duplicate`,
          );
        }
        const id = QuestionIDs.from(nextSequence(run.openQuestions.map((q) => q.id), QuestionIDs.prefix));
        const scope = await this.questionScope(run, draft.scope);
        return {
          change: {
            kind: "raise_question",
            question: { id, question: draft.question, blocking: draft.blocking, scope, status: "open" },
          },
        };
      }
      case "resolve_question": {
        if (!change.ref?.id) {
          throw new UltraPlanError("invalid_scope", "resolve_question requires a question ref");
        }
        const questionID = QuestionIDs.cast(change.ref.id);
        const question = run.openQuestions.find((q) => q.id === questionID);
        if (!question) {
          throw new UltraPlanError("unknown_reference", `Question ${questionID} does not exist in run ${run.id}`);
        }
        const resolutionText = readStringField(change.content, "resolution");
        return {
          change: {
            kind: "resolve_question",
            resolution: { questionID, resolution: resolutionText },
          },
        };
      }
      case "complete_architecture": {
        // Exact revision resolution order: explicit ref > an add_architecture
        // earlier in this SAME proposal > the currently committed revision.
        const architecture = await this.store.getArchitecture(run.id);
        const revision = change.ref?.revision ?? context.plannedArchitectureRevision ?? architecture?.revision;
        if (revision === undefined) {
          throw new UltraPlanError(
            "invalid_scope",
            "No Architecture revision exists to complete; include add_architecture in this proposal or commit one first",
          );
        }
        return { change: { kind: "complete_architecture", target: { id: "ARCH", revision } } };
      }
      case "complete_section": {
        // §4/§32: the target resolves from authoritative state — there is NO
        // "complete latest" resolution. An explicit ref (the tool path always
        // supplies the exact one) must BE the root's current approved
        // checkpoint; without a ref the active Section resolves.
        const sectionID = SectionIDs.cast(
          change.ref?.id ?? (run.activeWork?.type === "section" ? run.activeWork.id : ""),
        );
        if (!sectionID) {
          throw new UltraPlanError("invalid_scope", "complete_section requires a section ref");
        }
        const root = await this.store.getSection(run.id, sectionID);
        if (!root) {
          throw new UltraPlanError("invalid_scope", `Section ${sectionID} is not committed`);
        }
        if (root.status !== "active" || root.currentRevision === undefined || root.approvedRevision === undefined) {
          throw new UltraPlanError(
            "invalid_scope",
            `Section ${root.id} cannot complete: completion requires an ACTIVE Section with an approved checkpoint (status ${root.status}, currentRevision ${root.currentRevision ?? "none"}, approvedRevision ${root.approvedRevision ?? "none"})`,
            { sectionID: root.id },
          );
        }
        if (root.currentRevision !== root.approvedRevision) {
          throw new UltraPlanError(
            "revision_mismatch",
            `Section ${root.id} pointers diverge (currentRevision ${root.currentRevision} != approvedRevision ${root.approvedRevision}); commit a checkpoint before completing`,
            { sectionID: root.id },
          );
        }
        const targetRevision = change.ref?.revision ?? root.approvedRevision;
        if (targetRevision !== root.approvedRevision) {
          throw new UltraPlanError(
            "revision_mismatch",
            `Section completion must target the exact current approved checkpoint ${root.id}@${root.approvedRevision} (got @${targetRevision}) — no "complete latest" resolution exists`,
            { sectionID: root.id, target: targetRevision },
          );
        }
        const revision = await this.store.getSectionRevision(run.id, { id: root.id, revision: targetRevision });
        if (!revision) {
          throw new UltraPlanError("revision_missing", `Section revision ${root.id}@${targetRevision} does not exist`);
        }
        if (
          revision.projection.contract.sectionID !== root.id ||
          revision.projection.contract.revision !== targetRevision
        ) {
          throw new UltraPlanError(
            "invalid_scope",
            `The completed revision's contract identity does not match ${root.id}@${targetRevision}`,
            { sectionID: root.id, revision: targetRevision },
          );
        }
        // §33: deterministic state projection captured at freeze for the
        // approval view — identity/presentation metadata only, never design
        // content (the committed revision and contract are not re-approved).
        const allSections = await this.store.listSections(run.id);
        return {
          change: {
            kind: "complete_section",
            target: { id: root.id, revision: targetRevision },
            completion: {
              sectionTitle: root.title,
              validation: root.validation,
              dependencies: root.dependencies.map((dep) => ({
                id: dep,
                status: allSections.find((section) => section.id === dep)?.status ?? ("pending" as const),
              })),
            },
          },
          affectedSection: root.id,
        };
      }
    }
  }

  private async buildProposal(
    run: PlanningRun,
    type: ProposalTypeInput,
    scope: ProposalScopeInput,
    title: string,
    summary: string,
    changes: PreparedChange[],
  ): Promise<PreparedProposal> {
    // Stage/type legality (the capability gate has already run).
    const stage: PlanningStage = run.stage;
    const allowed: Record<ProposalTypeInput, readonly PlanningStage[]> = {
      design_checkpoint: ["architecture", "detail"],
      architecture_completion: ["architecture"],
      section_completion: ["detail"],
      amendment: ["architecture", "detail"],
    };
    if (!allowed[type].includes(stage)) {
      throw new UltraPlanError(
        "proposal_type_invalid",
        `Proposal type "${type}" is not valid in stage ${stage}`,
        { type, stage },
      );
    }
    if (changes.length === 0) {
      throw new UltraPlanError("invalid_scope", "A proposal requires at least one change");
    }

    // Phase 2C workflow boundaries (deterministic, no heuristics):
    // - complete_architecture carries stage-transition authority and therefore
    //   exists ONLY inside architecture_completion proposals;
    // - an architecture_completion proposal MUST carry it (§8: the completion
    //   commit and the architecture → detail transition are one transaction);
    // - add_architecture is architecture-stage only (the initial ARCH@1 path).
    // Phase 2E2 mirrors the completion boundary for Sections: complete_section
    // exists ONLY inside section_completion proposals, and a section_completion
    // proposal MUST carry one.
    const isCompletion = type === "architecture_completion";
    if (isCompletion && !changes.some((change) => change.kind === "complete_architecture")) {
      throw new UltraPlanError(
        "proposal_type_invalid",
        "architecture_completion proposals must contain a complete_architecture change",
        { type },
      );
    }
    const isSectionCompletion = type === "section_completion";
    if (isSectionCompletion && !changes.some((change) => change.kind === "complete_section")) {
      throw new UltraPlanError(
        "proposal_type_invalid",
        "section_completion proposals must contain a complete_section change",
        { type },
      );
    }
    for (const change of changes) {
      if (change.kind === "complete_architecture" && !isCompletion) {
        throw new UltraPlanError(
          "proposal_type_invalid",
          "complete_architecture is only valid inside an architecture_completion proposal",
          { kind: change.kind, type, stage },
        );
      }
      if (change.kind === "complete_section" && !isSectionCompletion) {
        throw new UltraPlanError(
          "proposal_type_invalid",
          "complete_section is only valid inside a section_completion proposal",
          { kind: change.kind, type, stage },
        );
      }
      if (change.kind === "add_architecture" && stage !== "architecture") {
        throw new UltraPlanError(
          "proposal_type_invalid",
          `add_architecture requires stage=architecture (run is in ${stage})`,
          { kind: change.kind, stage },
        );
      }
    }

    const { scope: proposalScope, sectionID: scopeSectionID } = await this.proposalScope(
      run,
      type,
      scope,
    );
    // Freeze-time resolution: each working draft is resolved into a fully
    // typed committed intent. IDs and resulting revision numbers are assigned
    // HERE so the user approves exact resulting objects (no HEAD-relative
    // ambiguity inside an approved proposal). Stored changes are never
    // `content: unknown`.
    const parsedChanges: ProposalChange[] = [];
    const affectedDecisions: DecisionID[] = [];
    const affectedSections = new Set<SectionID>();
    let plannedArchitectureRevision: number | undefined;
    const plannedDecisionIds = new Set<DecisionID>();
    const plannedQuestions: OpenQuestion[] = [];
    for (const change of changes) {
      if (!PREPARED_CHANGE_KINDS.includes(change.kind)) {
        throw new UltraPlanError(
          "proposal_kind_unsupported",
          `Change kind "${String(change.kind)}" is not part of the frozen proposal-change vocabulary`,
        );
      }
      const resolved = await this.resolveChange(run, change, {
        plannedArchitectureRevision,
        plannedDecisionIds,
        plannedQuestions,
      });
      parsedChanges.push(resolved.change);
      if (resolved.change.kind === "add_architecture") {
        plannedArchitectureRevision = resolved.change.architecture.revision;
      }
      if (resolved.change.kind === "add_decision") {
        plannedDecisionIds.add(resolved.change.decision.id);
      }
      if (resolved.change.kind === "raise_question") {
        plannedQuestions.push(resolved.change.question);
      }
      if (resolved.affectedDecision) affectedDecisions.push(resolved.affectedDecision);
      if (resolved.affectedSection) affectedSections.add(resolved.affectedSection);
    }

    if (!run.headSnapshot) {
      throw new UltraPlanError(
        "invalid_scope",
        `Run ${run.id} has no HEAD snapshot to bind the proposal to`,
      );
    }

    const proposal: Proposal = {
      id: ProposalIDs.from(
        nextSequence((await this.store.listProposals(run.id)).map((p) => p.id), ProposalIDs.prefix),
      ),
      type,
      scope: proposalScope,
      revision: 1,
      status: "ready",
      title,
      summary,
      changes: parsedChanges,
      dependencies: [],
      impact: {
        affectedSections: [
          ...(scopeSectionID ? [scopeSectionID] : []),
          ...[...affectedSections].filter((id) => id !== scopeSectionID),
        ],
        affectedDecisions,
      },
      createdFrom: { id: run.headSnapshot },
    };
    return this.freezeProposal(run, proposal);
  }

  /**
   * Content-addressed freeze shared by every proposal path: the hash covers
   * the proposal WITHOUT the hash field (stableStringify drops undefined),
   * then is attached and the proposal is persisted immutably. A future
   * Approval binds to exactly this hash.
   */
  private async freezeProposal(run: PlanningRun, proposal: Proposal): Promise<PreparedProposal> {
    if (!run.headSnapshot) {
      throw new UltraPlanError(
        "invalid_scope",
        `Run ${run.id} has no HEAD snapshot to bind the proposal to`,
      );
    }
    const hash = computeProposalHash(proposal);
    const frozen: Proposal = { ...proposal, hash };
    await this.store.saveProposal(run.id, frozen);
    return { proposal: frozen, hash };
  }

  /**
   * Phase 2D §25/§26: ONE atomic semantic operation — freeze the COMPLETE
   * initial Section DAG. The model supplies draft-local keys, titles,
   * objectives, dependency keys, and the initial focus; the Harness does
   * everything authoritative (§3/§7/§8):
   *
   *   validate draft shape → assign SEC-### (durable allocator, draft order =
   *   canonical order) → resolve dependency keys to exact ids → validate the
   *   full DAG → freeze one design_checkpoint proposal scoped to the EXACT
   *   committed ArchitectureRef, including select_initial_section.
   *
   * `add_section` / `select_initial_section` are deliberately NOT part of the
   * generic prepare_proposal vocabulary — loose incremental section creation
   * cannot produce a partially committed initial DAG.
   */
  async prepareSectionDecomposition(
    sessionID: string,
    input: SectionDecompositionInput,
  ): Promise<PreparedProposal> {
    const run = requireRun(
      await this.authorizeTool(sessionID, "ultraplan_prepare_section_decomposition"),
      "prepare_decomposition",
    );
    // Structural preconditions (defense beyond the capability substate gate).
    if (run.sections.length > 0) {
      throw new UltraPlanError(
        "invalid_scope",
        `Run ${run.id} already has a committed Section DAG; the initial decomposition is one atomic proposal and later changes require an amendment flow`,
        { sections: run.sections.length },
      );
    }
    const architecture = await this.store.getArchitecture(run.id);
    if (!architecture || !run.architecture) {
      throw new UltraPlanError(
        "unknown_reference",
        `Section decomposition requires a committed Architecture in run ${run.id}`,
        { planID: run.id },
      );
    }

    // -- Draft shape validation (§7/§17) -------------------------------------
    const drafts = input.sections;
    if (!Array.isArray(drafts) || drafts.length === 0) {
      throw new UltraPlanError("invalid_scope", "A decomposition requires at least one section");
    }
    const keyIndex = new Map<string, number>();
    for (const [index, draft] of drafts.entries()) {
      if (typeof draft.key !== "string" || draft.key.length === 0) {
        throw new UltraPlanError("invalid_scope", `Section ${index} requires a non-empty draft-local key`);
      }
      if (typeof draft.title !== "string" || draft.title.trim().length === 0) {
        throw new UltraPlanError("invalid_scope", `Section "${draft.key}" requires a non-empty title`);
      }
      if (typeof draft.objective !== "string" || draft.objective.trim().length === 0) {
        throw new UltraPlanError("invalid_scope", `Section "${draft.key}" requires a non-empty objective`);
      }
      if (keyIndex.has(draft.key)) {
        throw new UltraPlanError("invalid_scope", `Duplicate draft-local key "${draft.key}"`);
      }
      keyIndex.set(draft.key, index);
    }
    const seenEdges = new Set<string>();
    for (const [index, draft] of drafts.entries()) {
      const deps = draft.dependsOn ?? [];
      for (const dep of deps) {
        const depIndex = keyIndex.get(dep);
        if (depIndex === undefined) {
          throw new UltraPlanError(
            "unknown_reference",
            `Section "${draft.key}" depends on unknown key "${dep}"`,
          );
        }
        if (dep === draft.key) {
          throw new UltraPlanError("invalid_scope", `Section "${draft.key}" cannot depend on itself`);
        }
        if (depIndex >= index) {
          throw new UltraPlanError(
            "invalid_scope",
            `Section "${draft.key}" depends on "${dep}", which appears later in the list — dependencies must reference EARLIER sections (this keeps the approved order canonical and the graph acyclic)`,
          );
        }
        const edge = `${dep}->${draft.key}`;
        if (seenEdges.has(edge)) {
          throw new UltraPlanError("invalid_scope", `Duplicate dependency edge "${dep}" -> "${draft.key}"`);
        }
        seenEdges.add(edge);
      }
    }
    if (typeof input.initialSection !== "string" || !keyIndex.has(input.initialSection)) {
      throw new UltraPlanError(
        "unknown_reference",
        `initialSection "${String(input.initialSection)}" is not a key of this decomposition`,
      );
    }

    // -- Authoritative resolution (§7/§8/§12) --------------------------------
    // Durable allocator semantics: continue the run's committed SEC sequence.
    // Draft order IS the canonical order and is frozen into the proposal.
    let sequence = nextSequence(run.sections.map((ref) => ref.id), SectionIDs.prefix);
    const idByKey = new Map<string, SectionID>();
    for (const draft of drafts) {
      idByKey.set(draft.key, SectionIDs.from(sequence++));
    }
    const sections: ApprovedSectionRoot[] = drafts.map((draft) => ({
      id: idByKey.get(draft.key) as SectionID,
      title: draft.title,
      objective: draft.objective,
      dependencies: (draft.dependsOn ?? []).map((key) => idByKey.get(key) as SectionID),
      status: "pending",
      validation: "valid",
    }));
    // The existing Section-DAG invariant layer, as the final freeze-time gate.
    assertAcyclicSections(sections);
    const initialRef: SectionRef = { id: idByKey.get(input.initialSection) as SectionID };

    const proposal: Proposal = {
      id: ProposalIDs.from(
        nextSequence((await this.store.listProposals(run.id)).map((p) => p.id), ProposalIDs.prefix),
      ),
      // §5: the initial decomposition is a coherent architecture-derived
      // design checkpoint — no new proposal type exists.
      type: "design_checkpoint",
      scope: { id: "ARCH", revision: architecture.revision },
      revision: 1,
      status: "ready",
      title: "Initial Section decomposition",
      summary: `Establish the project-specific Section DAG for ARCH@${architecture.revision}: ${sections.length} section(s), initial focus ${initialRef.id}.`,
      changes: [
        ...sections.map((section) => ({ kind: "add_section" as const, section })),
        { kind: "select_initial_section" as const, section: initialRef },
      ],
      dependencies: [],
      impact: { affectedSections: sections.map((section) => section.id), affectedDecisions: [] },
      createdFrom: { id: run.headSnapshot as never },
    };
    return this.freezeProposal(run, proposal);
  }

  /**
   * Phase 2E1 §5-§14: ONE semantic model-facing operation — freeze the active
   * Section's detailed design into the next exact SectionRevision checkpoint
   * Proposal. Deliberately narrow:
   *
   *   - the target is ALWAYS run.activeWork (cross-section focus switching is
   *     Phase 2E2); no model-authored authoritative section id is accepted;
   *   - the first checkpoint of a revision-less root freezes
   *     `add_section_revision` (resulting revision 1); every later checkpoint
   *     freezes `amend_section` bound to the EXACT prior revision — no
   *     "amend latest" ambiguity (§6);
   *   - dependency contract bindings are resolved BY THE HARNESS at freeze —
   *     exact SEC-X@N where the dependency is approved, explicit absence
   *     otherwise; the user approves "designed against exactly SEC-X@N" (§12/§14);
   *   - contract consistency is validated deterministically, no LLM at freeze
   *     or commit (§11): contract invariants/interfaces/decisions may only
   *     restate facts the revision itself states; provides/requires are
   *     explicit approved projection content, not claimed proofs;
   *   - a dependency without an approved contract does NOT block the
   *     checkpoint (design may proceed ahead of dependency completion); the
   *     commit marks the root needs_review until a revalidated checkpoint
   *     lands (§13; protocol §6.6).
   *
   * `add_section_revision` is deliberately NOT part of the generic
   * prepare_proposal vocabulary — loose incremental revision creation would
   * bypass the active-work discipline and the exact-revision chain.
   */
  async prepareSectionCheckpoint(sessionID: string, input: SectionCheckpointInput): Promise<PreparedProposal> {
    const run = requireRun(
      await this.authorizeTool(sessionID, "ultraplan_prepare_section_checkpoint"),
      "prepare_section_checkpoint",
    );
    // Structural preconditions (defense beyond the capability substate gate).
    if (run.sections.length === 0) {
      throw new UltraPlanError(
        "invalid_scope",
        `Run ${run.id} has no committed Section DAG; the initial decomposition comes first`,
        { planID: run.id },
      );
    }
    if (run.activeWork?.type !== "section") {
      throw new UltraPlanError(
        "invalid_scope",
        `Run ${run.id} has no active Section focus; a checkpoint targets activeWork`,
        { activeWork: run.activeWork },
      );
    }
    const target = run.activeWork.id;
    const root = await this.store.getSection(run.id, target);
    if (!root) {
      throw new UltraPlanError(
        "unknown_reference",
        `Active work ${target} is not a committed Section of run ${run.id}`,
        { sectionID: target },
      );
    }

    // -- Draft shape validation (§8; closed contract, no free-form blob) -----
    const problem = requireTrimmed(input.problem, "problem");
    const design = requireTrimmed(input.design, "design");
    const interfaces: InterfaceSpec[] = (input.interfaces ?? []).map((spec, index) => {
      const name = requireTrimmed(spec?.name, `interfaces[${index}].name`);
      const description = requireTrimmed(spec?.description, `interfaces[${index}].description`);
      if (spec.signature !== undefined && typeof spec.signature !== "string") {
        throw new UltraPlanError("invalid_scope", `interfaces[${index}].signature must be a string`);
      }
      return { name, description, ...(spec.signature !== undefined ? { signature: spec.signature } : {}) };
    });
    const interfaceNames = new Set(interfaces.map((spec) => spec.name));
    if (interfaceNames.size !== interfaces.length) {
      throw new UltraPlanError("invalid_scope", "Interface names must be unique within a revision");
    }
    const invariants = readStringList(input.invariants, "invariants");
    const failureModes: FailureMode[] = (input.failureModes ?? []).map((mode, index) => {
      const description = requireTrimmed(mode?.description, `failureModes[${index}].description`);
      if (mode.mitigation !== undefined && typeof mode.mitigation !== "string") {
        throw new UltraPlanError("invalid_scope", `failureModes[${index}].mitigation must be a string`);
      }
      return { description, ...(mode.mitigation !== undefined ? { mitigation: mode.mitigation } : {}) };
    });

    // -- Dependency context (§12): exact structural coverage -----------------
    const committedSections = await this.store.listSections(run.id);
    const sectionById = new Map(committedSections.map((section) => [section.id, section]));
    const dependencies: Dependency[] = [];
    const recordedDeps = new Set<SectionID>();
    for (const [index, dep] of (input.dependencies ?? []).entries()) {
      const depID = SectionIDs.cast(requireTrimmed(dep?.sectionID, `dependencies[${index}].sectionID`));
      if (depID === target) {
        throw new UltraPlanError("invalid_scope", `Section ${target} cannot depend on itself`);
      }
      if (recordedDeps.has(depID)) {
        throw new UltraPlanError("invalid_scope", `Dependency ${depID} is recorded more than once`);
      }
      const depRoot = sectionById.get(depID);
      if (!depRoot) {
        throw new UltraPlanError(
          "unknown_reference",
          `Dependency ${depID} is not a committed Section of run ${run.id}`,
          { sectionID: depID },
        );
      }
      const consumes = readStringList(dep?.consumes, `dependencies[${index}].consumes`);
      // §14: the Harness resolves the EXACT approved contract revision — the
      // model can never bind "latest".
      dependencies.push({
        sectionID: depID,
        consumes,
        ...(depRoot.approvedRevision !== undefined ? { contractRevision: depRoot.approvedRevision } : {}),
      });
      recordedDeps.add(depID);
    }
    const missingDeps = root.dependencies.filter((dep) => !recordedDeps.has(dep));
    if (missingDeps.length > 0) {
      throw new UltraPlanError(
        "invalid_scope",
        `The revision must record the exact structural dependency context: ${target} depends on ${missingDeps.join(", ")}, which the draft omits`,
        { sectionID: target, missing: missingDeps },
      );
    }
    const extraDeps = [...recordedDeps].filter((dep) => !root.dependencies.includes(dep));
    if (extraDeps.length > 0) {
      throw new UltraPlanError(
        "invalid_scope",
        `The draft records ${extraDeps.join(", ")}, which are not structural dependencies of ${target} in the committed DAG — structural edges change only through amendment proposals`,
        { sectionID: target, extra: extraDeps },
      );
    }
    // Deterministic consumption check: a consumes name must be provided by the
    // bound dependency contract (strongest rule the support types support).
    for (const dep of dependencies) {
      if (dep.contractRevision === undefined) continue;
      const depRevision = await this.store.getSectionRevision(run.id, {
        id: dep.sectionID,
        revision: dep.contractRevision,
      });
      if (!depRevision) {
        throw new UltraPlanError(
          "unknown_reference",
          `Dependency contract ${dep.sectionID}@${dep.contractRevision} does not exist`,
          { sectionID: dep.sectionID, revision: dep.contractRevision },
        );
      }
      for (const name of dep.consumes) {
        if (!depRevision.projection.contract.provides.includes(name)) {
          throw new UltraPlanError(
            "invalid_scope",
            `${target} consumes "${name}" from ${dep.sectionID}, but ${dep.sectionID}@${dep.contractRevision} does not provide it`,
            { sectionID: dep.sectionID, contractRevision: dep.contractRevision, provides: name },
          );
        }
      }
    }

    // -- Related committed references (§22/§23): must already exist -----------
    const committedDecisions = await this.store.listDecisions(run.id);
    const decisions: DecisionID[] = (input.decisions ?? []).map((id, index) => {
      const decisionID = DecisionIDs.cast(requireTrimmed(id, `decisions[${index}]`));
      if (!committedDecisions.some((committed) => committed.id === decisionID)) {
        throw new UltraPlanError(
          "unknown_reference",
          `Decision ${decisionID} is not committed; Phase 2E1 checkpoints reference committed decisions only`,
          { decisionID },
        );
      }
      return decisionID;
    });
    const openQuestions: QuestionID[] = (input.openQuestions ?? []).map((id, index) => {
      const questionID = QuestionIDs.cast(requireTrimmed(id, `openQuestions[${index}]`));
      if (!run.openQuestions.some((question) => question.id === questionID)) {
        throw new UltraPlanError(
          "unknown_reference",
          `Question ${questionID} does not exist in run ${run.id}`,
          { questionID },
        );
      }
      return questionID;
    });
    const impacts: SectionID[] = (input.impacts ?? []).map((id, index) => {
      const impactID = SectionIDs.cast(requireTrimmed(id, `impacts[${index}]`));
      if (!sectionById.has(impactID)) {
        throw new UltraPlanError(
          "unknown_reference",
          `Impact ${impactID} is not a committed Section root; impacts resolve to existing sections and never mutate them`,
          { sectionID: impactID },
        );
      }
      return impactID;
    });

    // -- Contract consistency (§11; deterministic, no LLM) --------------------
    const contractInput = input.projection?.contract;
    if (typeof contractInput !== "object" || contractInput === null) {
      throw new UltraPlanError(
        "invalid_scope",
        "A checkpoint requires the dependency-facing contract projection",
      );
    }
    const compact = requireTrimmed(input.projection?.compact, "projection.compact");
    const provides = readStringList(contractInput.provides, "projection.contract.provides");
    const requires = readStringList(contractInput.requires, "projection.contract.requires");
    const contractInvariants = readStringList(contractInput.invariants, "projection.contract.invariants");
    for (const invariant of contractInvariants) {
      if (!invariants.includes(invariant)) {
        throw new UltraPlanError(
          "invalid_scope",
          `Contract invariant "${invariant}" is not an invariant of this revision — the contract may only restate revision facts`,
          { invariant },
        );
      }
    }
    const contractInterfaces: InterfaceRef[] = (contractInput.interfaces ?? []).map((ref, index) => {
      const name = requireTrimmed(ref?.name, `projection.contract.interfaces[${index}].name`);
      if (!interfaceNames.has(name)) {
        throw new UltraPlanError(
          "invalid_scope",
          `Contract interface "${name}" is not defined by this revision — the contract may only expose revision interfaces`,
          { interface: name },
        );
      }
      if (ref.providedBy !== undefined && ref.providedBy !== target) {
        throw new UltraPlanError(
          "invalid_scope",
          `Contract interface "${name}" claims providedBy ${ref.providedBy}; this contract belongs to ${target}`,
          { interface: name, providedBy: ref.providedBy },
        );
      }
      return { name, ...(ref.providedBy !== undefined ? { providedBy: ref.providedBy } : {}) };
    });
    const contractDecisions: DecisionRef[] = (contractInput.decisions ?? []).map((ref, index) => {
      const decisionID = DecisionIDs.cast(requireTrimmed(ref?.id, `projection.contract.decisions[${index}].id`));
      if (!decisions.includes(decisionID)) {
        throw new UltraPlanError(
          "invalid_scope",
          `Contract decision ${decisionID} is not referenced by this revision — the contract may only cite decisions the revision states`,
          { decisionID },
        );
      }
      const committed = committedDecisions.find((decision) => decision.id === decisionID);
      if (!committed || typeof ref.revision !== "number" || ref.revision !== committed.revision) {
        throw new UltraPlanError(
          "unknown_reference",
          `Contract decision ${decisionID}@${String(ref?.revision)} does not resolve to the committed decision (${committed ? `@${committed.revision}` : "missing"})`,
          { decisionID },
        );
      }
      return { id: decisionID, revision: ref.revision };
    });

    // -- Freeze the exact resulting revision ----------------------------------
    const now = this.now();
    const revisionNumber = root.currentRevision === undefined ? 1 : root.currentRevision + 1;
    if (!run.headSnapshot) {
      throw new UltraPlanError(
        "invalid_scope",
        `Run ${run.id} has no HEAD snapshot to bind the checkpoint proposal to`,
      );
    }
    const revision: ApprovedSectionRevision = {
      sectionID: target,
      revision: revisionNumber,
      status: "approved",
      createdAt: now,
      problem,
      design,
      interfaces,
      invariants,
      failureModes,
      dependencies,
      decisions,
      openQuestions,
      impacts,
      projection: {
        compact,
        contract: {
          sectionID: target,
          revision: revisionNumber,
          provides,
          requires,
          invariants: contractInvariants,
          interfaces: contractInterfaces,
          decisions: contractDecisions,
        },
      },
    };
    const change: ProposalChange =
      root.currentRevision === undefined
        ? { kind: "add_section_revision", revision }
        : {
            kind: "amend_section",
            supersedes: { id: target, revision: root.currentRevision },
            revision,
          };
    const proposal: Proposal = {
      id: ProposalIDs.from(
        nextSequence((await this.store.listProposals(run.id)).map((p) => p.id), ProposalIDs.prefix),
      ),
      type: "design_checkpoint",
      scope: { id: target },
      revision: 1,
      status: "ready",
      title: `Section checkpoint ${target}@${revisionNumber}`,
      summary:
        root.currentRevision === undefined
          ? `First approved design checkpoint of ${target}: freezes the detailed design, compact projection, and dependency-facing contract as immutable revision 1.`
          : `Revises ${target} from the exact prior revision ${target}@${root.currentRevision} into immutable revision ${revisionNumber}; previous revisions remain immutable and readable.`,
      changes: [change],
      dependencies: [],
      impact: {
        affectedSections: [target, ...impacts.filter((id) => id !== target)],
        affectedDecisions: [...decisions],
      },
      createdFrom: { id: run.headSnapshot },
    };
    return this.freezeProposal(run, proposal);
  }

  private async proposalScope(
    run: PlanningRun,
    type: ProposalTypeInput,
    scope: ProposalScopeInput,
  ): Promise<{ scope: Proposal["scope"]; sectionID?: ReturnType<typeof SectionIDs.cast> }> {
    if (scope.type === "architecture") {
      if (type === "section_completion") {
        throw new UltraPlanError("invalid_scope", "section_completion proposals target a section");
      }
      const architecture = await this.store.getArchitecture(run.id);
      return { scope: { id: "ARCH", revision: architecture?.revision ?? 1 } };
    }
    if (type === "architecture_completion") {
      throw new UltraPlanError("invalid_scope", "architecture_completion proposals target the architecture");
    }
    const sectionID = SectionIDs.cast(scope.sectionID);
    if (!run.sections.some((ref) => ref.id === sectionID)) {
      throw new UltraPlanError("invalid_scope", `Section ${sectionID} is not part of run ${run.id}`);
    }
    return { scope: { id: sectionID }, sectionID };
  }

  private async activate(run: PlanningRun): Promise<RuntimeActivationResult | null> {
    if (!this.runtime) return null;
    const input: RuntimeActivationInput = { planID: run.id, sessionID: run.sessionID };
    const result = await this.runtime.activatePlanningRuntime(input);
    await this.store.appendEvent(run.id, {
      type: "runtime.activated",
      mechanism: result.mechanism,
      unsupported: result.unsupported,
    });
    return result;
  }
}

async function finish(
  store: PlanStore,
  run: PlanningRun,
  created: boolean,
  activation: RuntimeActivationResult | null,
): Promise<StartOrResumeResult> {
  await store.appendEvent(run.id, { type: "status.reported" });
  return { run, created, activation, statusText: await renderRunStatus(store, run) };
}

/**
 * Deterministic status projection resolved from the store: the committed
 * Architecture's real approval status and the approved-section count. Never
 * derived from conversation text.
 */
async function renderRunStatus(store: PlanStore, run: PlanningRun): Promise<string> {
  const architecture = run.architecture ? await store.getArchitecture(run.id) : undefined;
  const sections = await store.listSections(run.id);
  const activeSectionID = run.activeWork?.type === "section" ? run.activeWork.id : undefined;
  const activeSection =
    run.stage === "detail" && activeSectionID
      ? sections.find((section) => section.id === activeSectionID)
      : undefined;
  // Phase 2E2 §36: deterministic completion state for the checkpointed active
  // Section — "ready", or "blocked" with the first deterministic reason.
  let completion: StatusDetails["completion"];
  if (activeSection && activeSection.currentRevision !== undefined) {
    const unapprovedDep = activeSection.dependencies.find(
      (dep) => sections.find((section) => section.id === dep)?.status !== "approved",
    );
    if (unapprovedDep !== undefined) {
      completion = { state: "blocked", reason: `dependency ${unapprovedDep} not approved` };
    } else if (activeSection.validation !== "valid") {
      completion = { state: "blocked", reason: `validation ${activeSection.validation}` };
    } else {
      completion = { state: "ready" };
    }
  }
  // Phase 2F §47 + Phase 2G §57 + Phase 2H §57: the synthesis block derives
  // from the latest frozen input, its latest manifest, the CURRENT validation
  // report, the running admission, and the deterministic finalization state —
  // never from conversation state. Phase 2I §85 adds the current final_plan
  // Proposal state (none / ready / awaiting user).
  let synthesis: StatusDetails["synthesis"];
  if (run.stage === "synthesis") {
    const [input, manifests] = await Promise.all([
      store.getLatestSynthesisInput(run.id),
      store.listSynthesisManifests(run.id),
    ]);
    const manifest = input
      ? manifests
          .filter((candidate) => candidate.input.id === input.id)
          .reduce<SynthesisManifest | undefined>(
            (latest, candidate) => (latest === undefined || candidate.revision > latest.revision ? candidate : latest),
            undefined,
          )
      : undefined;
    let validation: NonNullable<StatusDetails["synthesis"]>["validation"];
    let finalization: NonNullable<StatusDetails["synthesis"]>["finalization"] = { state: "unavailable" };
    if (input && manifest) {
      const identity = { inputHash: input.hash, manifestHash: manifest.hash, validatorProtocol: SEMANTIC_VALIDATION_PROTOCOL };
      const [report, admission] = await Promise.all([
        store.findValidationReportByIdentity(run.id, identity),
        store.getSemanticValidationAdmission(run.id, validationIdentityKey(identity)),
      ]);
      validation = {
        ...(admission && !report ? { running: true } : {}),
        ...(report
          ? { report: { id: report.id, result: report.result, findings: report.findings.length } }
          : {}),
      };
      finalization = await resolveSynthesisFinalization(store, run, input, manifest, report ?? undefined);
    }
    const finalProposal = await resolveCurrentFinalProposal(store, run, {
      candidateCurrent: finalization.candidate?.current === true,
    });
    synthesis = {
      ...(input
        ? {
            input: {
              id: input.id,
              baseSnapshot: input.baseSnapshot.id,
              hash: input.hash,
              stale: run.headSnapshot !== input.baseSnapshot.id,
            },
          }
        : {}),
      ...(manifest ? { manifest: { id: manifest.id, revision: manifest.revision, hash: manifest.hash } } : {}),
      ...(validation ? { validation } : {}),
      finalization,
      ...(finalProposal
        ? { finalProposal: { ref: finalProposal.proposal.id, status: finalProposal.proposal.status as "ready" | "awaiting_approval" } }
        : {}),
    };
  }
  // Phase 2I §85: the committed FinalPlan of a final-stage run.
  let finalPlanDetails: StatusDetails["finalPlan"];
  // Phase 2J §66-§70: the durable handoff/delivery state of a final run.
  let handoffDetails: StatusDetails["handoff"];
  if (run.stage === "final" && (run.lifecycle === "handoff_pending" || run.lifecycle === "completed")) {
    if (run.finalPlan) {
      const committed = await store.getFinalPlan(run.id, run.finalPlan.id, run.finalPlan.revision);
      if (committed) {
        finalPlanDetails = { ref: `${committed.id}@${committed.revision}`, status: committed.status };
      }
    }
    const handoff = await store.findExecutionHandoffForPlan(run.id);
    const delivery = handoff ? await store.getHandoffDelivery(run.id, handoff.id) : undefined;
    if (run.lifecycle === "completed") {
      handoffDetails = {
        ...(handoff ? { ref: handoff.id } : {}),
        state: delivery?.state === "delivered" ? "delivered" : "not_prepared",
        lifecycle: "completed",
      };
    } else {
      handoffDetails = {
        ...(handoff ? { ref: handoff.id } : {}),
        state: delivery?.state ?? "not_prepared",
        lifecycle: "handoff_pending",
      };
    }
  }
  return renderStatus(run, {
    ...(architecture ? { architectureStatus: architecture.status } : {}),
    approvedSections: sections.filter((section) => section.status === "approved").length,
    ...(activeSection ? { activeSection } : {}),
    ...(completion ? { completion } : {}),
    ...(synthesis ? { synthesis } : {}),
    ...(finalPlanDetails ? { finalPlan: finalPlanDetails } : {}),
    ...(handoffDetails ? { handoff: handoffDetails } : {}),
  });
}

/**
 * Phase 2I §22/§85: resolve the run's current final_plan Proposal (ready or
 * awaiting_approval) — there is at most one PRESENTABLE Final Proposal at a
 * time; older/rejected ones are immutable history. `current` (derived, never
 * stored) means the Proposal binds the run's CURRENT newest FinalPlanCandidate;
 * callers with full context additionally pass the DERIVED candidate currency
 * (resolveSynthesisFinalization), so a stale binding never reads as current.
 */
export async function resolveCurrentFinalProposal(
  store: PlanStore,
  run: PlanningRun,
  context: { candidateCurrent: boolean },
): Promise<{ proposal: Proposal; current: boolean } | undefined> {
  let found: Proposal | undefined;
  for (const proposal of await store.listProposals(run.id)) {
    if (proposal.type !== "final_plan") continue;
    if (proposal.status !== "ready" && proposal.status !== "awaiting_approval") continue;
    if (found === undefined || proposal.id > found.id) found = proposal;
  }
  if (!found) return undefined;
  const change = found.changes.find(
    (c): c is Extract<ProposalChange, { kind: "add_final_plan" }> => c.kind === "add_final_plan",
  );
  let current = false;
  if (change && context.candidateCurrent) {
    const candidate = await store.getCurrentFinalPlanCandidate(run.id);
    const binding = change.finalPlan.finalPlanCandidate;
    current =
      !!candidate &&
      candidate.id === binding.id &&
      candidate.revision === binding.revision &&
      candidate.hash === binding.hash;
  }
  return {
    proposal: found,
    current,
  };
}

/**
 * Phase 2H §51/§57: the deterministic finalization STATUS projection,
 * resolved from durable state only (never conversation). Currency is DERIVED
 * (§51) — a stored candidate is never mutated to mark it stale:
 *   - before a current clean report ................... unavailable
 *   - clean report, no passing candidate ............... not run (+ any
 *     current-identity audit line; a PASS audit without a candidate is the
 *     interrupted-freeze crash window and stays "not run" — the candidate
 *     freeze is what completes finalization)
 *   - current-identity audit blocked ................... blocked (+ blockers)
 *   - a CURRENT candidate exists ....................... passed (stage stays
 *     synthesis; final approval not requested — 2H §76)
 * A stale candidate renders with "(stale)" and never passes as current.
 */
export async function resolveSynthesisFinalization(
  store: PlanStore,
  run: PlanningRun,
  input: SynthesisInput | undefined,
  manifest: SynthesisManifest | undefined,
  report: ValidationReport | undefined,
): Promise<NonNullable<NonNullable<import("../memory/renderer.js").StatusDetails["synthesis"]>["finalization"]>> {
  if (!report || report.result !== "clean" || !input || !manifest) {
    return { state: "unavailable" };
  }
  const snapshot = run.headSnapshot ? ((await store.getHeadSnapshot(run.id)) ?? undefined) : undefined;
  const fingerprint =
    snapshot && snapshot.id === run.headSnapshot
      ? (await computeCurrentEvidenceStateHash(store, run.id, snapshot)).hash
      : undefined;
  const liveBlockers =
    run.openQuestions.some((question) => question.blocking && question.status === "open") ||
    run.conflicts.some((conflict) => conflict.severity === "blocking" && conflict.status === "open");

  const candidate = await store.getCurrentFinalPlanCandidate(run.id);
  if (
    candidate &&
    snapshot &&
    fingerprint !== undefined &&
    !liveBlockers &&
    run.headSnapshot === candidate.baseSnapshot.id &&
    candidate.synthesisInput.hash === input.hash &&
    candidate.synthesisManifest.hash === manifest.hash &&
    candidate.semanticValidation.hash === report.hash
  ) {
    const boundAudit = await store.getEvidenceAudit(run.id, candidate.evidenceAudit.id);
    const current =
      !!boundAudit &&
      boundAudit.hash === candidate.evidenceAudit.hash &&
      boundAudit.result === "pass" &&
      boundAudit.headSnapshot.id === run.headSnapshot &&
      boundAudit.evidenceStateHash === fingerprint;
    if (current) {
      return {
        state: "passed",
        audit: { id: candidate.evidenceAudit.id, result: "pass" },
        candidate: { ref: `${candidate.id}@${candidate.revision}`, current: true },
      };
    }
  }

  const candidateLine = candidate
    ? { ref: `${candidate.id}@${candidate.revision}`, current: false }
    : undefined;

  // The audit bound to the CURRENT audited state (identity incl. fingerprint).
  const currentAudit =
    snapshot && fingerprint !== undefined && run.headSnapshot
      ? ((await store.findEvidenceAuditByIdentity(run.id, {
          headSnapshot: run.headSnapshot,
          inputHash: input.hash,
          manifestHash: manifest.hash,
          reportHash: report.hash,
          evidenceStateHash: fingerprint,
        })) ?? undefined)
      : undefined;

  if (currentAudit && currentAudit.result === "blocked") {
    return {
      state: "blocked",
      audit: { id: currentAudit.id, result: "blocked" },
      blockers: currentAudit.blockers.map((blocker) =>
        blocker.evidence
          ? `${blocker.code}(${blocker.evidence.id}${blocker.evidence.revision !== undefined ? `@${blocker.evidence.revision}` : ""})`
          : blocker.code,
      ),
    };
  }
  // The audit's evidence term may pass while the GATE is blocked by live
  // terms (questions/conflicts/sections) — derive that honestly too (§57).
  if (liveBlockers) {
    return {
      state: "blocked",
      ...(currentAudit ? { audit: { id: currentAudit.id, result: currentAudit.result } } : {}),
      blockers: [
        ...run.openQuestions
          .filter((question) => question.blocking && question.status === "open")
          .map((question) => `blocking_question(${question.id})`),
        ...run.conflicts
          .filter((conflict) => conflict.severity === "blocking" && conflict.status === "open")
          .map((conflict) => `blocking_conflict(${conflict.id})`),
      ],
      ...(candidateLine ? { candidate: candidateLine } : {}),
    };
  }
  return {
    state: "not_run",
    ...(currentAudit ? { audit: { id: currentAudit.id, result: currentAudit.result } } : {}),
    ...(candidateLine ? { candidate: candidateLine } : {}),
  };
}

export type { UltraPlanCapability };
