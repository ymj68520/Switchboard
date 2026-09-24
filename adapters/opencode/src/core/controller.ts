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
} from "./ids.js";
import type { DecisionID, PlanID, SectionID } from "./ids.js";
import { assertCapability, requireRun, type UltraPlanCapability } from "./capabilities.js";
import { InMemoryStartAdmissionLedger, type StartAdmission, type StartAdmissionLedger } from "./admissions.js";
import { checkFinalization, type FinalizationCheck } from "./invariants.js";
import { transitionStage } from "./state-machine.js";
import type { EvidenceRef, MemoryRef, SectionRevisionRef, Timestamp } from "./refs.js";
import { renderNoRunStatus, renderStatus } from "../memory/renderer.js";
import type { PlanStore } from "../memory/store.js";
import type {
  RuntimeActivationInput,
  RuntimeActivationResult,
  UltraPlanRuntime,
} from "../runtime/types.js";
import { TOOL_CONTRACTS } from "../tools/contracts.js";
import type { Observation, SourceLocator } from "../repository/observations.js";
import type { Evidence, EvidenceScope, EvidenceSource } from "../repository/evidence.js";
import type { Proposal } from "../transaction/types.js";
import type { ApprovalRequest, UserApprovalDecision, BegunApproval } from "../transaction/approval.js";
import { applyApprovalDecision } from "../transaction/approval.js";
import { computeProposalHash } from "../transaction/hash.js";
import type {
  Approval,
  ApprovedDecision,
  ApprovedSectionRevision,
  PlanCommit,
  ProposalChange,
  SectionRevisionDraft,
} from "../transaction/types.js";
import type { Snapshot } from "../memory/snapshots.js";
import { UltraPlanError } from "./errors.js";
import type {
  Architecture,
  Conflict,
  Decision,
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
    | "final_plan";
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
    ref: MemoryRef | { kind: "run" };
    artifact:
      | PlanningRun
      | Architecture
      | Section
      | SectionRevision
      | Decision
      | Evidence
      | OpenQuestion
      | Conflict
      | Proposal;
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

/** Change kinds accepted by the Phase 2A proposal-intent boundary. */
export const PREPARED_CHANGE_KINDS = [
  "add_decision",
  "amend_decision",
  "amend_section",
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
}

export class UltraPlanController {
  private readonly store: PlanStore;
  private readonly ledger: ObservationLedgerRef | undefined;
  private readonly admissions: StartAdmissionLedger;
  private readonly startCommand: string;
  private readonly runtime: UltraPlanRuntime | undefined;
  private readonly now: () => Timestamp;

  constructor(options: ControllerOptions) {
    this.store = options.store;
    this.ledger = options.ledger;
    this.admissions = options.admissions ?? new InMemoryStartAdmissionLedger(options.now);
    this.startCommand = options.startCommand ?? "ultra-plan";
    this.runtime = options.runtime;
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
   */
  async startOrResume(sessionID: string, goal?: string): Promise<StartOrResumeResult> {
    this.admissions.consume(sessionID, this.startCommand, this.now());

    const existing = await this.store.findActiveRunBySession(sessionID);

    if (existing) {
      await this.store.appendEvent(existing.id, { type: "run.resumed", sessionID });
      const activation = await this.activate(existing);
      const run = (await this.store.getRun(existing.id)) ?? existing;
      return finish(this.store, run, false, activation);
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
    return run ? renderStatus(run) : null;
  }

  /** Full status report, including runs that already completed (read-only). */
  async statusReport(
    sessionID: string,
  ): Promise<{ run: PlanningRun | undefined; statusText: string }> {
    const run = await this.store.findLatestRunBySession(sessionID);
    return { run, statusText: run ? renderStatus(run) : renderNoRunStatus(sessionID) };
  }

  // -- Authorization (the enforcement gate for every model-facing op) -------

  /**
   * Resolve the run a tool invocation applies to and assert the capability
   * matrix grants it. Single authoritative path — tools carry no stage rules
   * of their own.
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
    assertCapability(run, contract.capability);
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
        const depSection = await this.store.getSection(planID, dep);
        if (!depSection?.approvedRevision) continue;
        const revisionRef: SectionRevisionRef = { id: dep, revision: depSection.approvedRevision };
        const revision = await this.store.getSectionRevision(planID, revisionRef);
        if (revision) {
          result.artifacts.push({
            ref: { kind: "section", id: dep, revision: depSection.approvedRevision },
            artifact: revision,
          });
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

    const ref = buildMemoryRef(query.ref);
    result.artifacts.push({ ref, artifact: await this.readRef(planID, run, query.ref) });
    return result;
  }

  private async readRef(
    planID: PlanID,
    run: PlanningRun,
    flat: FlatMemoryRef,
  ): Promise<MemoryReadResult["artifacts"][number]["artifact"]> {
    switch (flat.kind) {
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
      case "snapshot":
      case "commit":
      case "final_plan":
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

  async requestCompletion(sessionID: string, input: { sectionID: string }): Promise<PreparedProposal> {
    const run = requireRun(await this.authorizeTool(sessionID, "ultraplan_request_completion"), "request_completion");
    const sectionID = SectionIDs.cast(input.sectionID);
    if (!run.sections.some((ref) => ref.id === sectionID)) {
      throw new UltraPlanError("invalid_scope", `Section ${sectionID} is not part of run ${run.id}`);
    }
    return this.buildProposal(
      run,
      "section_completion",
      { type: "section", sectionID: input.sectionID },
      `Complete ${sectionID}`,
      `Declare ${sectionID} complete and treat it as a closed dependency.`,
      [{ kind: "complete_section", ref: { kind: "section", id: input.sectionID } }],
    );
  }

  async requestReopen(sessionID: string, input: { ref: FlatMemoryRef }): Promise<PreparedProposal> {
    const run = requireRun(await this.authorizeTool(sessionID, "ultraplan_request_reopen"), "request_reopen");
    const ref = buildMemoryRef(input.ref);
    if (ref.kind !== "section" && ref.kind !== "decision") {
      throw new UltraPlanError("invalid_scope", "Reopen requests target approved sections or decisions");
    }
    await this.assertRefResolves(run, ref);
    // A decision-targeted amendment scopes to the architecture (decision
    // ownership per section lands with the Phase 2B engine).
    const scope: ProposalScopeInput =
      ref.kind === "section" ? { type: "section", sectionID: ref.id } : { type: "architecture" };
    const changeKind = ref.kind === "section" ? "amend_section" : "amend_decision";
    return this.buildProposal(
      run,
      "amendment",
      scope,
      `Reopen ${ref.kind === "section" ? ref.id : ref.id}`,
      `Reopen approved ${ref.kind} ${ref.id ?? "?"} for amendment through the transaction pipeline.`,
      [{ kind: changeKind, ref: input.ref }],
    );
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
    const run = requireRun(await this.authorizeTool(sessionID, "ultraplan_request_synthesis"), "request_synthesis");

    const architecture = await this.store.getArchitecture(run.id);
    const sections = await this.store.listSections(run.id);
    const evidence = await this.store.listEvidence(run.id);
    const check: FinalizationCheck = checkFinalization({
      architecture,
      sections,
      openQuestions: run.openQuestions,
      conflicts: run.conflicts,
      evidence,
    });
    if (!check.ok) {
      throw new UltraPlanError(
        "finalization_blocked",
        `Finalization preconditions failed: ${check.failures.join(", ")}`,
        { failures: check.failures },
      );
    }

    const moved = transitionStage(run, "final");
    const saved = await this.store.saveRun(moved);
    return { run: saved, statusText: renderStatus(saved) };
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
   */
  private async resolveChange(
    run: PlanningRun,
    change: PreparedChange,
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
        const architecture = await this.store.getArchitecture(run.id);
        if (!architecture) {
          throw new UltraPlanError(
            "invalid_scope",
            "No committed architecture exists to complete (the architecture workflow lands in a later phase)",
          );
        }
        const revision = change.ref?.revision ?? architecture.revision;
        return { change: { kind: "complete_architecture", target: { id: "ARCH", revision } } };
      }
      case "complete_section": {
        if (!change.ref?.id) {
          throw new UltraPlanError("invalid_scope", "complete_section requires a section ref");
        }
        const section = await this.store.getSection(run.id, SectionIDs.cast(change.ref.id));
        if (!section) {
          throw new UltraPlanError("invalid_scope", `Section ${change.ref.id} is not committed`);
        }
        if (section.currentRevision === undefined) {
          throw new UltraPlanError("invalid_scope", `Section ${section.id} has no revision to complete`);
        }
        return {
          change: {
            kind: "complete_section",
            target: { id: section.id, revision: change.ref.revision ?? section.currentRevision },
          },
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
    for (const change of changes) {
      if (!PREPARED_CHANGE_KINDS.includes(change.kind)) {
        throw new UltraPlanError(
          "proposal_kind_unsupported",
          `Change kind "${String(change.kind)}" is not part of the frozen proposal-change vocabulary`,
        );
      }
      const resolved = await this.resolveChange(run, change);
      parsedChanges.push(resolved.change);
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

    // Content-addressed freeze: the hash covers the proposal WITHOUT the hash
    // field (stableStringify drops undefined), then is attached. A future
    // Approval binds to exactly this hash.
    const hash = computeProposalHash(proposal);
    const frozen: Proposal = { ...proposal, hash };
    await this.store.saveProposal(run.id, frozen);
    return { proposal: frozen, hash };
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
  return { run, created, activation, statusText: renderStatus(run) };
}

export type { UltraPlanCapability };
