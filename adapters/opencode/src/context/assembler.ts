/**
 * The Context Assembler — frozen architecture §13-§19 + R2.
 *
 * A deterministic context compiler over ONE snapshot-consistent read view
 * (context/state.ts). Pipeline: Memory Store → Structural Retrieval → Context
 * Projection → Budget Manager → Renderer (§13). No RAG, no embeddings, no
 * vector DB, no semantic reranker, no repository index — structural
 * relationships in Plan Memory are the only retrieval mechanism.
 *
 * Assembly is READ-ONLY (brief §4): it reads authoritative state, projects it,
 * budgets it, renders it. It never creates Proposals, mutates the PlanningRun,
 * moves HEAD, promotes Evidence, resolves Questions/Conflicts, creates
 * PlanCommits, or changes workflow stage.
 *
 * Every assembly binds to the authority identity (brief §6): the trace and the
 * rendered envelope carry PlanID, HEAD commit, stage, and activeWork. Context
 * may be stale as a read projection if HEAD moves after assembly — the
 * transaction/capability revalidation remains the only authority (brief §94:
 * rendered context is informative, never authority).
 */
import { UltraPlanError } from "../core/errors.js";
import type { ContextTraceID, DecisionID, EvidenceID, PlanID, SectionID } from "../core/ids.js";
import type { MemoryRef } from "../core/refs.js";
import type {
  Architecture,
  Decision,
  OpenQuestion,
  Section,
  SectionContract,
  SectionRevision,
  Conflict,
  Constraint,
} from "../core/types.js";
import { getCapabilities, ULTRA_PLAN_CAPABILITIES } from "../core/capabilities.js";
import type { Evidence, EvidenceScope } from "../repository/evidence.js";
import type { Proposal } from "../transaction/types.js";
import { renderL0ProtocolFragment } from "./protocol.js";
import {
  projectArchitectureFull,
  projectArchitectureIdentity,
  projectArchitectureRelevant,
  projectArchitectureSummary,
  projectConstraintIdentity,
  projectConstraintRelevant,
  projectConstraintSummary,
  projectConflictIdentity,
  projectConflictRelevant,
  projectConflictSummary,
  projectDecisionFull,
  projectDecisionIdentity,
  projectDecisionRelevant,
  projectDecisionSummary,
  projectEvidenceIdentity,
  projectEvidenceSummary,
  projectInterfaceSpec,
  projectProposalIdentity,
  projectProposalRelevant,
  projectProposalSummary,
  projectQuestionIdentity,
  projectQuestionRelevant,
  projectQuestionSummary,
  projectSectionContract,
  projectSectionIdentity,
  projectSectionRelevant,
  projectSectionRevisionFull,
  projectSectionRevisionIdentity,
  projectSectionRevisionRelevant,
  projectSectionRevisionSummary,
  projectSectionSummary,
} from "./projections.js";
import { applyBudget, computeTraceId, DEFAULT_CONTEXT_BUDGET_TOKENS, estimateTokens } from "./budget.js";
import type { PlanningContextState } from "./state.js";
import type {
  ContextFragment,
  ContextLayer,
  ContextPriority,
  ContextProjectionVariant,
  ContextTrace,
  ContextTraceExcludedEntry,
  ContextTraceIncludedEntry,
  DetailLevel,
  RetrievalReason,
} from "./trace.js";
import { DETAIL_LEVEL_ORDER } from "./trace.js";

/** The configured Ultra Plan context budget (estimated tokens) + overflow semantics. */
export interface ContextBudgetConfig {
  budgetTokens: number;
  /**
   * Required-minimum overflow behavior (brief §17). "render" (default):
   * render ALL required minimum content, mark trace.overBudget, surface a
   * structured warning — the host transform's throw semantics are unverified,
   * so failing the turn is opt-in. "fail": throw `context_budget_exceeded`
   * before the model inference.
   */
  overflow: "render" | "fail";
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudgetConfig = {
  budgetTokens: DEFAULT_CONTEXT_BUDGET_TOKENS,
  overflow: "render",
};

export interface AssemblePlanningContextOptions extends Partial<ContextBudgetConfig> {
  /**
   * "planning" (default): the full L0-L5 assembly for an active run.
   * "handoff-status": the minimal NON-authoritative status context for a
   * handoff_pending run (L0 boundary + L1 + read-only L5) — Build/handoff
   * does not receive planning L2-L4 assembly (brief §66/§67).
   */
  mode?: "planning" | "handoff-status";
  /**
   * Optional exact refs to upgrade deterministically (brief §57 — frozen
   * architecture §15's "explicit user references" without any conversation
   * parsing). Upgraded fragments render at `full`; refs with no otherwise-
   * retrieved fragment are projected directly. No production caller is wired
   * yet; the capability is exposed for structured paths only.
   */
  explicitRefs?: MemoryRef[];
}

export interface AssembledPlanningContext {
  rendered: string;
  trace: ContextTrace;
  /** Structured, secret-free diagnostics (e.g. required-minimum overflow). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Fragment construction helpers
// ---------------------------------------------------------------------------

function variantChain(
  levels: Partial<Record<DetailLevel, string>>,
  desired: DetailLevel,
  minimum: DetailLevel,
): ContextProjectionVariant[] {
  const start = DETAIL_LEVEL_ORDER.indexOf(desired);
  const end = DETAIL_LEVEL_ORDER.indexOf(minimum);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`invalid projection chain ${desired} -> ${minimum}`);
  }
  return DETAIL_LEVEL_ORDER.slice(start, end + 1).map((level) => {
    const text = levels[level];
    if (text === undefined) throw new Error(`missing ${level} projection variant`);
    return { level, text };
  });
}

function makeFragment(params: {
  id: string;
  layer: ContextLayer;
  priority: ContextPriority;
  reason: RetrievalReason;
  reasons?: RetrievalReason[];
  ref?: MemoryRef;
  orderKey: string;
  levels: Partial<Record<DetailLevel, string>>;
  desiredDetail: DetailLevel;
  minimumDetail: DetailLevel;
  droppable: boolean;
}): ContextFragment {
  return {
    id: params.id,
    layer: params.layer,
    priority: params.priority,
    reason: params.reason,
    reasons: params.reasons ?? [params.reason],
    ...(params.ref !== undefined ? { ref: params.ref } : {}),
    orderKey: params.orderKey,
    desiredDetail: params.desiredDetail,
    minimumDetail: params.minimumDetail,
    droppable: params.droppable,
    variants: variantChain(params.levels, params.desiredDetail, params.minimumDetail),
  };
}

// ---------------------------------------------------------------------------
// Derived workflow substate (deterministic; mirrors the capability matrix)
// ---------------------------------------------------------------------------

export type WorkflowSubstate =
  | "exploring"
  | "designing"
  | "decomposition-needed"
  | "architecture-remediation"
  | "section-ready/revisionless"
  | "section-ready/checkpointed"
  | "synthesis/no-input"
  | "synthesis/input-ready"
  | "synthesis/manifest-ready"
  | "synthesis/validation-findings"
  | "synthesis/validation-clean"
  | "synthesis/candidate-ready"
  | "synthesis/final-proposal"
  | "final";

export function deriveWorkflowSubstate(state: PlanningContextState): WorkflowSubstate {
  const { run } = state;
  if (run.stage === "discovery") return "exploring";
  if (run.stage === "architecture") return "designing";
  if (run.stage === "final") return "final";
  if (run.stage === "detail") {
    if (run.activeWork?.type === "architecture") return "architecture-remediation";
    if (run.sections.length === 0) return "decomposition-needed";
    const active = resolveActiveSection(state);
    return active?.currentRevision !== undefined ? "section-ready/checkpointed" : "section-ready/revisionless";
  }
  // Synthesis substates — the same derivation the capability matrix uses.
  const synthesis = state.synthesis;
  if (!synthesis.input) return "synthesis/no-input";
  if (!synthesis.manifest) return "synthesis/input-ready";
  if (!synthesis.report) return "synthesis/manifest-ready";
  if (synthesis.report.result === "findings") return "synthesis/validation-findings";
  if (synthesis.finalProposal) return "synthesis/final-proposal";
  if (synthesis.candidate && synthesis.candidate.baseSnapshot.id === run.headSnapshot) {
    return "synthesis/candidate-ready";
  }
  return "synthesis/validation-clean";
}

function resolveActiveSection(state: PlanningContextState): Section | undefined {
  if (state.run.activeWork?.type !== "section") return undefined;
  const activeID = state.run.activeWork.id;
  return state.sections.find((section) => section.id === activeID);
}

/** The exact current approved/current revision content (approved pointer first). */
function resolveActiveRevision(section: Section, state: PlanningContextState): SectionRevision | undefined {
  if (section.approvedRevision === undefined && section.currentRevision === undefined) return undefined;
  return state.sectionRevisions.get(section.id);
}

function sectionContractOf(revision: SectionRevision | undefined): SectionContract | undefined {
  return revision?.projection.contract;
}

// ---------------------------------------------------------------------------
// Layer builders — L0/L1/L2
// ---------------------------------------------------------------------------

function buildProtocolFragment(state: PlanningContextState): ContextFragment {
  return makeFragment({
    id: "L0:protocol",
    layer: "L0",
    priority: "P0",
    reason: "protocol",
    orderKey: "000",
    levels: { full: renderL0ProtocolFragment(state.run, buildProtocolInput(state), { compact: true }) },
    desiredDetail: "full",
    minimumDetail: "full",
    droppable: false,
  });
}

/** The caller-resolved projections the L0 guidance needs (identity lines only). */
function buildProtocolInput(state: PlanningContextState) {
  const active = resolveActiveSection(state);
  const activeSection = active
    ? {
        id: active.id,
        title: active.title,
        objective: active.objective,
        dependencies: active.dependencies,
        ...(active.currentRevision !== undefined ? { currentRevision: active.currentRevision } : {}),
        validation: active.validation,
      }
    : undefined;
  const input = state.synthesis.input;
  const synthesis =
    state.run.stage === "synthesis"
      ? {
          ...(input
            ? {
                inputID: input.id,
                baseSnapshot: input.baseSnapshot.id,
                inputHash: input.hash,
                stale: state.run.headSnapshot !== input.baseSnapshot.id,
              }
            : {}),
          ...(state.synthesis.manifest
            ? {
                manifestRef: `${state.synthesis.manifest.id}@${state.synthesis.manifest.revision}`,
                manifestHash: state.synthesis.manifest.hash,
              }
            : {}),
          ...(state.synthesis.report ? { validationResult: state.synthesis.report.result } : {}),
          ...(state.synthesis.finalProposal
            ? {
                finalProposal: {
                  ref: state.synthesis.finalProposal.id,
                  status: state.synthesis.finalProposal.status as "ready" | "awaiting_approval",
                },
              }
            : {}),
        }
      : undefined;
  return {
    ...(activeSection ? { activeSection } : {}),
    ...(synthesis ? { synthesis } : {}),
  };
}

function buildRunStateFragment(state: PlanningContextState): ContextFragment {
  const { run } = state;
  const blockingQuestions = run.openQuestions.filter((q) => q.blocking && q.status === "open");
  const blockingConflicts = run.conflicts.filter((c) => c.severity === "blocking" && c.status === "open");
  const approved = state.sections.filter((s) => s.status === "approved").length;
  const activeOrReopened = state.sections.filter((s) => s.status === "active" || s.status === "reopened").length;
  const pending = state.sections.filter((s) => s.status === "pending" || s.status === "awaiting_approval").length;
  const active = resolveActiveSection(state);
  const activeLine =
    run.activeWork?.type === "architecture"
      ? "active: ARCH (architecture remediation)"
      : active
        ? `active: ${active.id} "${active.title}"`
        : "active: none";
  const archLine = run.architecture
    ? `architecture: ARCH@${run.architecture.revision}${state.architecture ? ` [${state.architecture.status}]` : " (pointer only)"}`
    : "architecture: none";
  const text = [
    `plan: ${run.id}`,
    `lifecycle: ${run.lifecycle}`,
    `stage: ${run.stage}`,
    `workflow_substate: ${deriveWorkflowSubstate(state)}`,
    activeLine,
    `head_commit: ${run.headCommit ?? "none"}`,
    `head_snapshot: ${run.headSnapshot ?? "none"}`,
    archLine,
    ...(run.sectionDecompositionArchitecture
      ? [`section_dag_decomposed_from: ARCH@${run.sectionDecompositionArchitecture.revision}`]
      : run.stage === "detail" && run.sections.length === 0
        ? ["section_dag_decomposed_from: none (no current decomposition)"]
        : []),
    `sections: total=${state.sections.length} approved=${approved} active_or_reopened=${activeOrReopened} pending=${pending}`,
    `blocking_questions: ${blockingQuestions.length}${blockingQuestions.length > 0 ? ` (${blockingQuestions.map((q) => q.id).join(", ")})` : ""}`,
    `blocking_conflicts: ${blockingConflicts.length}${blockingConflicts.length > 0 ? ` (${blockingConflicts.map((c) => c.id).join(", ")})` : ""}`,
    `open_questions: ${run.openQuestions.filter((q) => q.status === "open").length}`,
    `open_conflicts: ${run.conflicts.filter((c) => c.status === "open").length}`,
  ].join("\n");
  return makeFragment({
    id: "L1:run-state",
    layer: "L1",
    priority: "P0",
    reason: "run_state",
    orderKey: "000",
    levels: { full: text },
    desiredDetail: "full",
    minimumDetail: "full",
    droppable: false,
  });
}

function buildGoalFragment(state: PlanningContextState): ContextFragment {
  return makeFragment({
    id: "L2:goal",
    layer: "L2",
    priority: "P0",
    reason: "goal",
    orderKey: "000",
    levels: { full: `Goal: ${state.run.goal.statement}` },
    desiredDetail: "full",
    minimumDetail: "full",
    droppable: false,
  });
}

function constraintLevels(constraint: Constraint) {
  return {
    identity: projectConstraintIdentity(constraint),
    summary: projectConstraintSummary(constraint),
    relevant: projectConstraintRelevant(constraint),
  };
}

function buildConstraintFragments(state: PlanningContextState): ContextFragment[] {
  const fragments: ContextFragment[] = [];
  const active = state.constraints.filter((constraint) => constraint.status === "active");
  // Hard + active constraints are automatically P0 (brief §15).
  for (const constraint of active.filter((c) => c.severity === "hard")) {
    fragments.push(
      makeFragment({
        id: `L2:constraint:${constraint.id}`,
        layer: "L2",
        priority: "P0",
        reason: "global_constraint",
        ref: { kind: "constraint", id: constraint.id },
        orderKey: constraint.id,
        levels: constraintLevels(constraint),
        desiredDetail: "summary",
        minimumDetail: "summary", // exact ID + statement, non-droppable (brief §49)
        droppable: false,
      }),
    );
  }
  // Soft constraints are NOT globally P0 (brief §15): optional supporting
  // context, first constraints dropped under pressure.
  for (const constraint of active.filter((c) => c.severity === "soft")) {
    fragments.push(
      makeFragment({
        id: `L2:constraint:${constraint.id}`,
        layer: "L2",
        priority: "P3",
        reason: "global_constraint",
        ref: { kind: "constraint", id: constraint.id },
        orderKey: constraint.id,
        levels: constraintLevels(constraint),
        desiredDetail: "summary",
        minimumDetail: "identity",
        droppable: true,
      }),
    );
  }
  return fragments;
}

// ---------------------------------------------------------------------------
// Artifact level renderers
// ---------------------------------------------------------------------------

function architectureLevels(architecture: Architecture) {
  return {
    identity: projectArchitectureIdentity(architecture),
    summary: projectArchitectureSummary(architecture),
    relevant: projectArchitectureRelevant(architecture, architecture.unresolved.filter((q) => q.status === "open").map((q) => q.id)),
    full: projectArchitectureFull(architecture),
  };
}

function decisionLevels(decision: Decision) {
  return {
    identity: projectDecisionIdentity(decision),
    summary: projectDecisionSummary(decision),
    relevant: projectDecisionRelevant(decision),
    full: projectDecisionFull(decision),
  };
}

function questionLevels(question: OpenQuestion) {
  return {
    identity: projectQuestionIdentity(question),
    summary: projectQuestionSummary(question),
    relevant: projectQuestionRelevant(question),
  };
}

function conflictLevels(conflict: Conflict) {
  return {
    identity: projectConflictIdentity(conflict),
    summary: projectConflictSummary(conflict),
    relevant: projectConflictRelevant(conflict),
  };
}

function evidenceLevels(evidence: Evidence) {
  return {
    identity: projectEvidenceIdentity(evidence),
    summary: projectEvidenceSummary(evidence),
  };
}

function proposalLevels(proposal: Proposal) {
  return {
    identity: projectProposalIdentity(proposal),
    summary: projectProposalSummary(proposal),
    relevant: projectProposalRelevant(proposal),
  };
}

// ---------------------------------------------------------------------------
// Structural retrieval — dependency graph walks (brief §20/§21/§27)
// ---------------------------------------------------------------------------

/** Deterministic transitive dependency closure over the CURRENT Section DAG. */
export function transitiveDependencies(state: PlanningContextState, sectionID: SectionID): SectionID[] {
  const direct = new Set<SectionID>(state.sections.find((s) => s.id === sectionID)?.dependencies ?? []);
  const visited = new Set<SectionID>([sectionID]);
  const queue: SectionID[] = [...direct];
  const result: SectionID[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    if (!direct.has(current)) result.push(current);
    const section = state.sections.find((s) => s.id === current);
    for (const dependency of section?.dependencies ?? []) {
      if (!visited.has(dependency)) queue.push(dependency);
    }
  }
  return result.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Deterministic downstream impact over the CURRENT Section DAG (brief §27). */
export function downstreamSections(
  state: PlanningContextState,
  sectionID: SectionID,
): { direct: Section[]; transitive: Section[] } {
  const direct = state.sections.filter((section) => section.dependencies.includes(sectionID));
  const directIDs = new Set<SectionID>(direct.map((section) => section.id));
  const transitive: Section[] = [];
  const visited = new Set<SectionID>([sectionID, ...directIDs]);
  const queue: SectionID[] = [...directIDs];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const section of state.sections) {
      if (section.dependencies.includes(current) && !visited.has(section.id)) {
        visited.add(section.id);
        transitive.push(section);
        queue.push(section.id);
      }
    }
  }
  const canonical = (a: Section, b: Section) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { direct: [...direct].sort(canonical), transitive: [...transitive].sort(canonical) };
}

// ---------------------------------------------------------------------------
// Decision + Evidence retrieval collectors (dedup; brief §23/§42)
// ---------------------------------------------------------------------------

const PRIORITY_RANK: Record<ContextPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

function highestPriority(priorities: readonly ContextPriority[]): ContextPriority {
  return priorities.reduce<ContextPriority>(
    (best, current) => (PRIORITY_RANK[current] < PRIORITY_RANK[best] ? current : best),
    "P3",
  );
}

interface DecisionRetrieval {
  decision: Decision;
  priorities: ContextPriority[];
  reasons: RetrievalReason[];
}

class DecisionCollector {
  private readonly byKey = new Map<string, DecisionRetrieval>();

  add(decision: Decision, priority: ContextPriority, reason: RetrievalReason): void {
    const key = `${decision.id}@${decision.revision}`;
    const existing = this.byKey.get(key);
    if (existing) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      if (!existing.priorities.includes(priority)) existing.priorities.push(priority);
      return;
    }
    this.byKey.set(key, { decision, priorities: [priority], reasons: [reason] });
  }

  /** Canonical order: exact ref. */
  list(): DecisionRetrieval[] {
    return [...this.byKey.values()].sort((a, b) => {
      const keyA = `${a.decision.id}@${a.decision.revision}`;
      const keyB = `${b.decision.id}@${b.decision.revision}`;
      return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
    });
  }
}

interface EvidenceRetrieval {
  evidence: Evidence;
  priorities: ContextPriority[];
  reasons: RetrievalReason[];
}

class EvidenceCollector {
  private readonly byKey = new Map<string, EvidenceRetrieval>();

  add(evidence: Evidence, priority: ContextPriority, reason: RetrievalReason): void {
    const key = `${evidence.id}@${evidence.revision}`;
    const existing = this.byKey.get(key);
    if (existing) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      if (!existing.priorities.includes(priority)) existing.priorities.push(priority);
      return;
    }
    this.byKey.set(key, { evidence, priorities: [priority], reasons: [reason] });
  }

  /** Canonical order: exact ref (id, then revision). */
  list(): EvidenceRetrieval[] {
    return [...this.byKey.values()].sort((a, b) => {
      if (a.evidence.id !== b.evidence.id) return a.evidence.id < b.evidence.id ? -1 : 1;
      return a.evidence.revision - b.evidence.revision;
    });
  }
}

/**
 * Automatic context always reflects the CURRENT Evidence state (brief §43):
 * exact historical revisions stay reachable through plan_memory only.
 */
function resolveEvidenceRef(state: PlanningContextState, ref: { id: string; revision?: number }): Evidence | undefined {
  const latest = state.evidence.get(ref.id as EvidenceID);
  if (!latest) return undefined;
  if (ref.revision !== undefined && ref.revision !== latest.revision) return undefined;
  return latest;
}

function currentDecisionByID(state: PlanningContextState, id: DecisionID): Decision | undefined {
  return [...state.decisions.values()].find((decision) => decision.id === id);
}

/** Exact Evidence state behind a set of decisions (the represented edge only). */
function evidenceOfDecisions(
  collector: EvidenceCollector,
  state: PlanningContextState,
  decisions: readonly Decision[],
  priority: ContextPriority,
  reason: RetrievalReason,
): void {
  for (const decision of decisions) {
    for (const ref of decision.evidence ?? []) {
      const record = resolveEvidenceRef(state, ref);
      if (record) collector.add(record, priority, reason);
    }
  }
}

// ---------------------------------------------------------------------------
// L3 active-scope fragments — Section work (brief §18/§19/§20/§21/§22/§23/§24)
// ---------------------------------------------------------------------------

function buildSectionScopeFragments(state: PlanningContextState, active: Section): ContextFragment[] {
  const fragments: ContextFragment[] = [];
  const activeRevision = resolveActiveRevision(active, state);
  if (activeRevision === undefined && (active.currentRevision !== undefined || active.approvedRevision !== undefined)) {
    // The root binds a revision the snapshot resolves but the family lacks —
    // internally inconsistent state fails closed (brief §93).
    throw new UltraPlanError(
      "context_state_invalid",
      `Active section ${active.id} has a revision pointer but no resolvable committed revision content`,
      { ref: active.id },
    );
  }

  // 1. Active section root — the P0 active-artifact identity (brief §16/§44).
  fragments.push(
    makeFragment({
      id: `L3:section:${active.id}`,
      layer: "L3",
      priority: "P0",
      reason: "active_scope",
      ref: { kind: "section", id: active.id },
      orderKey: active.id,
      levels: {
        identity: projectSectionIdentity(active),
        summary: projectSectionSummary(active),
        relevant: projectSectionRelevant(active, {
          revisionState:
            active.status === "reopened"
              ? `status=reopened validation=${active.validation}; exact approved/current revision remains ${active.id}@${active.approvedRevision ?? active.currentRevision}`
              : active.currentRevision !== undefined
                ? `current revision ${active.id}@${active.currentRevision} (validation ${active.validation})`
                : "no committed revision yet (first checkpoint freezes revision 1)",
        }),
      },
      desiredDetail: "relevant",
      minimumDetail: "identity",
      droppable: false,
    }),
  );

  // 2. The exact current approved/current revision content (brief §18).
  if (activeRevision) {
    fragments.push(
      makeFragment({
        id: `L3:section-revision:${active.id}@${activeRevision.revision}`,
        layer: "L3",
        priority: "P1",
        reason: "active_scope",
        ref: { kind: "section", id: active.id, revision: activeRevision.revision },
        orderKey: `${active.id}@${activeRevision.revision}`,
        levels: {
          identity: projectSectionRevisionIdentity(activeRevision),
          summary: projectSectionRevisionSummary(activeRevision),
          relevant: projectSectionRevisionRelevant(activeRevision),
          full: projectSectionRevisionFull(activeRevision),
        },
        desiredDetail: "relevant",
        minimumDetail: "identity",
        droppable: false,
      }),
    );
  }

  // 3-4. Direct dependencies: exact SectionRef + exact approved revision +
  //      exact SectionContract, structurally resolved (brief §20).
  const transitiveIDs = transitiveDependencies(state, active.id);
  const inheritedDirect = new DecisionCollector();
  for (const dependencyID of active.dependencies) {
    const dependency = state.sections.find((s) => s.id === dependencyID);
    if (!dependency) {
      throw new UltraPlanError(
        "context_state_invalid",
        `Active section ${active.id} depends on ${dependencyID}, which is not a committed Section`,
        { dependency: dependencyID },
      );
    }
    const dependencyRevision =
      dependency.approvedRevision !== undefined ? state.sectionRevisions.get(dependencyID) : undefined;
    // A bound approved pointer with no revision content is corruption; an
    // unapproved dependency is legal current state (needs_review marking).
    if (dependency.approvedRevision !== undefined && dependencyRevision === undefined) {
      throw new UltraPlanError(
        "context_state_invalid",
        `Dependency ${dependencyID}@${dependency.approvedRevision} is approved but its committed revision content is missing`,
        { dependency: dependencyID },
      );
    }
    const contract = sectionContractOf(dependencyRevision);
    fragments.push(
      makeFragment({
        id: `L3:dependency:${dependencyID}`,
        layer: "L3",
        priority: "P1",
        reason: "direct_dependency",
        ref: {
          kind: "section",
          id: dependencyID,
          ...(dependencyRevision ? { revision: dependencyRevision.revision } : {}),
        },
        orderKey: dependencyID,
        levels: {
          identity: contract
            ? `${projectSectionIdentity(dependency)} contract=${contract.sectionID}@${contract.revision}`
            : projectSectionIdentity(dependency),
          summary: contract
            ? `${projectSectionSummary(dependency)}\n${projectSectionContract(contract)}`
            : `${projectSectionSummary(dependency)}\n(no approved contract yet)`,
          relevant: contract
            ? `${projectSectionContract(contract)}\n${dependencyRevision ? projectSectionRevisionSummary(dependencyRevision) : ""}`
            : `${projectSectionRelevant(dependency, {})}\n(no approved contract yet)`,
        },
        desiredDetail: "relevant",
        minimumDetail: "summary", // exact contract minimum (brief §49)
        droppable: false,
      }),
    );
    if (contract) {
      for (const ref of contract.decisions) {
        const decision = state.decisions.get(`${ref.id}@${ref.revision}`);
        if (!decision) {
          throw new UltraPlanError(
            "context_state_invalid",
            `Dependency contract ${contract.sectionID}@${contract.revision} references decision ${ref.id}@${ref.revision}, which does not exist at HEAD`,
            { ref: `${ref.id}@${ref.revision}` },
          );
        }
        inheritedDirect.add(decision, "P1", "direct_dependency");
      }
    }
  }

  // 5. Transitive dependencies — identity (contract id when present) at P2,
  //    deduplicated, droppable (brief §21).
  for (const dependencyID of transitiveIDs) {
    const dependency = state.sections.find((s) => s.id === dependencyID);
    if (!dependency) continue;
    const dependencyRevision =
      dependency.approvedRevision !== undefined ? state.sectionRevisions.get(dependencyID) : undefined;
    const contract = sectionContractOf(dependencyRevision);
    fragments.push(
      makeFragment({
        id: `L3:transitive-dependency:${dependencyID}`,
        layer: "L3",
        priority: "P2",
        reason: "transitive_dependency",
        ref: { kind: "section", id: dependencyID },
        orderKey: dependencyID,
        levels: {
          identity: contract
            ? `${projectSectionIdentity(dependency)} contract=${contract.sectionID}@${contract.revision}`
            : projectSectionIdentity(dependency),
          summary: contract
            ? `${projectSectionSummary(dependency)}\n${projectSectionContract(contract)}`
            : projectSectionSummary(dependency),
        },
        desiredDetail: "identity",
        minimumDetail: "identity",
        droppable: true,
      }),
    );
    if (contract) {
      for (const ref of contract.decisions) {
        const decision = state.decisions.get(`${ref.id}@${ref.revision}`);
        if (decision) inheritedDirect.add(decision, "P2", "transitive_dependency");
      }
    }
  }

  // 6-7. Section-scoped + inherited dependency decisions — one deduplicated
  //      pool by exact ref; effective priority = highest reason (brief §22/§23).
  const decisions = new DecisionCollector();
  for (const decisionID of activeRevision?.decisions ?? []) {
    const exact = currentDecisionByID(state, decisionID);
    if (!exact) {
      throw new UltraPlanError(
        "context_state_invalid",
        `Section revision ${activeRevision?.sectionID}@${activeRevision?.revision} references decision ${decisionID}, which does not exist at HEAD`,
        { ref: decisionID },
      );
    }
    decisions.add(exact, "P1", "explicit_reference");
  }
  for (const retrieval of inheritedDirect.list()) {
    decisions.add(retrieval.decision, highestPriority(retrieval.priorities), retrieval.reasons[0]!);
    for (const reason of retrieval.reasons) {
      const merged = decisions
        .list()
        .find((entry) => `${entry.decision.id}@${entry.decision.revision}` === `${retrieval.decision.id}@${retrieval.decision.revision}`);
      if (merged && !merged.reasons.includes(reason)) merged.reasons.push(reason);
    }
  }
  for (const retrieval of decisions.list()) {
    fragments.push(
      makeFragment({
        id: `L3:decision:${retrieval.decision.id}@${retrieval.decision.revision}`,
        layer: "L3",
        priority: highestPriority(retrieval.priorities),
        reason: retrieval.reasons[0]!,
        reasons: retrieval.reasons,
        ref: { kind: "decision", id: retrieval.decision.id, revision: retrieval.decision.revision },
        orderKey: `${retrieval.decision.id}@${retrieval.decision.revision}`,
        levels: decisionLevels(retrieval.decision),
        desiredDetail: "relevant",
        minimumDetail: "summary",
        droppable: false,
      }),
    );
  }

  // 8. Relevant interfaces: active revision + direct contracts (brief §24).
  const seenInterfaces = new Set<string>();
  for (const spec of activeRevision?.interfaces ?? []) {
    if (seenInterfaces.has(spec.name)) continue;
    seenInterfaces.add(spec.name);
    fragments.push(
      makeFragment({
        id: `L3:interface:${spec.name}`,
        layer: "L3",
        priority: "P1",
        reason: "active_scope",
        orderKey: `zz-iface-${spec.name}`,
        levels: { identity: spec.name, summary: projectInterfaceSpec(spec) },
        desiredDetail: "summary",
        minimumDetail: "identity",
        droppable: true,
      }),
    );
  }
  for (const dependencyID of active.dependencies) {
    const dependency = state.sections.find((s) => s.id === dependencyID);
    const contract = sectionContractOf(
      dependency && dependency.approvedRevision !== undefined ? state.sectionRevisions.get(dependencyID) : undefined,
    );
    if (!contract) continue;
    for (const ref of contract.interfaces) {
      if (seenInterfaces.has(ref.name)) continue;
      seenInterfaces.add(ref.name);
      fragments.push(
        makeFragment({
          id: `L3:interface:${ref.name}`,
          layer: "L3",
          priority: "P1",
          reason: "direct_dependency",
          orderKey: `zz-iface-${ref.name}`,
          levels: {
            identity: `${ref.name}${ref.providedBy ? ` (provided by ${ref.providedBy})` : ""}`,
            summary: projectInterfaceSpec({
              name: ref.name,
              description: `Required by dependency contract ${contract.sectionID}@${contract.revision}`,
            }),
          },
          desiredDetail: "summary",
          minimumDetail: "identity",
          droppable: true,
        }),
      );
    }
  }

  return fragments;
}

/**
 * Architecture-scoped L3 (brief §28/§29): the exact current Architecture at
 * relevant/full per budget (the L2 fragment upgrades), plus the exact
 * Decisions it references. NO invalidated historical Section DAG ever enters
 * current context — after an R1 amendment run.sections is structurally empty.
 */
function buildArchitectureScopeFragments(state: PlanningContextState): ContextFragment[] {
  const fragments: ContextFragment[] = [];
  const architecture = state.architecture;
  if (!architecture) return fragments;
  for (const decisionID of architecture.basedOn) {
    const exact = currentDecisionByID(state, decisionID);
    if (!exact) {
      throw new UltraPlanError(
        "context_state_invalid",
        `Architecture ${architecture.id}@${architecture.revision} references decision ${decisionID}, which does not exist at HEAD`,
        { ref: decisionID },
      );
    }
    fragments.push(
      makeFragment({
        id: `L3:architecture-decision:${exact.id}@${exact.revision}`,
        layer: "L3",
        priority: "P1",
        reason: "explicit_reference",
        ref: { kind: "decision", id: exact.id, revision: exact.revision },
        orderKey: `${exact.id}@${exact.revision}`,
        levels: decisionLevels(exact),
        desiredDetail: "relevant",
        minimumDetail: "summary",
        droppable: false,
      }),
    );
  }
  return fragments;
}

/** The synthesis derived-artifact identity capsule (brief §30) — compact identities, never full dumps. */
function buildSynthesisScopeFragment(state: PlanningContextState): ContextFragment | undefined {
  if (state.run.stage !== "synthesis") return undefined;
  const { input, manifest, report, audit, candidate, finalProposal } = state.synthesis;
  const lines: string[] = ["Synthesis workflow state (derived artifacts — NOT committed Plan Memory):"];
  if (input) {
    const stale = state.run.headSnapshot !== input.baseSnapshot.id;
    lines.push(
      `SynthesisInput: ${input.id} hash=${input.hash.slice(0, 16)} base=${input.baseSnapshot.id}${stale ? " STALE (HEAD moved past base)" : " current"}`,
    );
  } else {
    lines.push("SynthesisInput: none frozen yet");
  }
  lines.push(manifest ? `SynthesisManifest: ${manifest.id}@${manifest.revision} hash=${manifest.hash.slice(0, 16)}` : "SynthesisManifest: none");
  lines.push(report ? `SemanticValidation: ${report.id} result=${report.result} hash=${report.hash.slice(0, 16)}` : "SemanticValidation: not run");
  lines.push(audit ? `EvidenceAudit: ${audit.id} result=${audit.result}` : "EvidenceAudit: not run");
  if (candidate) {
    const headCurrent = candidate.baseSnapshot.id === state.run.headSnapshot;
    lines.push(
      `FinalPlanCandidate: ${candidate.id}@${candidate.revision} hash=${candidate.hash.slice(0, 16)} ${headCurrent ? "[head-current]" : "[stale]"}`,
    );
  } else {
    lines.push("FinalPlanCandidate: none");
  }
  lines.push(
    finalProposal
      ? `Final Proposal: ${finalProposal.id}@${finalProposal.revision} [${finalProposal.status}] (WORKING — NOT committed)`
      : "Final Proposal: none",
  );
  return makeFragment({
    id: "L3:synthesis-capsule",
    layer: "L3",
    priority: "P1",
    reason: "active_scope",
    orderKey: "001",
    levels: { identity: lines.join("\n"), summary: lines.join("\n") },
    desiredDetail: "summary",
    minimumDetail: "identity",
    droppable: false,
  });
}

// ---------------------------------------------------------------------------
// Main assembly
// ---------------------------------------------------------------------------

function currentProposal(state: PlanningContextState): Proposal | undefined {
  return state.proposals
    .filter((proposal) => proposal.status === "ready" || proposal.status === "awaiting_approval")
    .at(-1);
}

function capabilityContext(state: PlanningContextState): {
  synthesis?: {
    hasInput: boolean;
    hasManifest: boolean;
    report?: { result: "clean" | "findings" };
    candidate?: { current: boolean };
    finalProposal?: { status: "ready" | "awaiting_approval"; current: boolean };
  };
} {
  if (state.run.stage !== "synthesis") return {};
  return {
    synthesis: {
      hasInput: !!state.synthesis.input,
      hasManifest: !!state.synthesis.manifest,
      ...(state.synthesis.report ? { report: { result: state.synthesis.report.result } } : {}),
      ...(state.synthesis.candidate
        ? { candidate: { current: state.synthesis.candidate.baseSnapshot.id === state.run.headSnapshot } }
        : {}),
      ...(state.synthesis.finalProposal
        ? {
            finalProposal: {
              status: state.synthesis.finalProposal.status as "ready" | "awaiting_approval",
              current: true,
            },
          }
        : {}),
    },
  };
}

function capabilityChecklistText(state: PlanningContextState): string {
  const capabilities = getCapabilities(state.run, capabilityContext(state));
  const lines = ["Available operations in the current state:"];
  for (const capability of ULTRA_PLAN_CAPABILITIES) {
    lines.push(`- [${capabilities.has(capability) ? "x" : " "}] ${capability}`);
  }
  return lines.join("\n");
}

function conflictScopeMatches(
  conflict: Conflict,
  state: PlanningContextState,
  scope: { active: Section | undefined; architectureActiveScope: boolean },
): boolean {
  for (const ref of conflict.refs) {
    if (ref.kind === "architecture" && state.architecture) return true;
    if (ref.kind === "section" && scope.active && ref.id === scope.active.id) return true;
    if (ref.kind === "decision" && scope.active) {
      const revision = resolveActiveRevision(scope.active, state);
      if (revision?.decisions.includes(ref.id)) return true;
    }
  }
  return false;
}

/**
 * Question scope discrimination: `OpenQuestion.scope` is
 * `ArchitectureRef | SectionRef`, and the Architecture singleton is pinned to
 * the literal id "ARCH" (SectionIDs are always SEC-###), so the id IS the
 * discriminator.
 */
function questionScopeIsArchitecture(question: OpenQuestion): boolean {
  return question.scope.id === "ARCH";
}

/** Decisions reachable from a blocking question's scope through represented paths. */
function decisionsForQuestionScope(state: PlanningContextState, question: OpenQuestion): Decision[] {
  const result: Decision[] = [];
  if (questionScopeIsArchitecture(question)) {
    if (state.architecture) {
      for (const id of state.architecture.basedOn) {
        const exact = currentDecisionByID(state, id);
        if (exact) result.push(exact);
      }
    }
    return result;
  }
  const revision = state.sectionRevisions.get(question.scope.id as SectionID);
  for (const id of revision?.decisions ?? []) {
    const exact = currentDecisionByID(state, id);
    if (exact) result.push(exact);
  }
  return result;
}

/** Decisions reachable from a conflict's refs through represented paths. */
function decisionsForConflictScope(state: PlanningContextState, conflict: Conflict): Decision[] {
  const result: Decision[] = [];
  const sections: SectionID[] = [];
  let architecture = false;
  for (const ref of conflict.refs) {
    if (ref.kind === "architecture") architecture = true;
    if (ref.kind === "section") sections.push(ref.id);
    if (ref.kind === "decision") {
      const exact = currentDecisionByID(state, ref.id);
      if (exact) result.push(exact);
    }
  }
  for (const sectionID of sections) {
    const revision = state.sectionRevisions.get(sectionID);
    for (const id of revision?.decisions ?? []) {
      const exact = currentDecisionByID(state, id);
      if (exact) result.push(exact);
    }
  }
  if (architecture && state.architecture) {
    for (const id of state.architecture.basedOn) {
      const exact = currentDecisionByID(state, id);
      if (exact) result.push(exact);
    }
  }
  return result;
}

export function assemblePlanningContext(
  state: PlanningContextState,
  options: AssemblePlanningContextOptions = {},
): AssembledPlanningContext {
  const budgetConfig: ContextBudgetConfig = {
    budgetTokens: options.budgetTokens ?? DEFAULT_CONTEXT_BUDGET.budgetTokens,
    overflow: options.overflow ?? DEFAULT_CONTEXT_BUDGET.overflow,
  };
  const run = state.run;

  // -- Structural retrieval -------------------------------------------------
  const mode = options.mode ?? "planning";
  const fragments: ContextFragment[] = [
    buildProtocolFragment(state),
    buildRunStateFragment(state),
  ];
  if (mode === "planning") {
    fragments.push(buildGoalFragment(state));
    fragments.push(...buildConstraintFragments(state));
  }

  const archRemediation = run.activeWork?.type === "architecture";
  const architectureActiveScope =
    mode === "planning" &&
    (run.stage === "architecture" || archRemediation || (run.stage === "detail" && run.sections.length === 0));

  // L2: the required compact approved Architecture projection (brief §16
  // resolution: P2 for compression/order decisions, but its minimum compact
  // representation is non-droppable — P2 never implies this required L2
  // fragment may disappear entirely). When the Architecture is the ACTIVE
  // scope, the same fragment upgrades to relevant/full (frozen architecture
  // §15 detail levels; brief §28).
  if (mode === "planning" && state.architecture) {
    fragments.push(
      makeFragment({
        id: "L2:architecture",
        layer: "L2",
        priority: "P2",
        reason: "architecture_compact",
        reasons: architectureActiveScope ? ["architecture_compact", "active_scope"] : ["architecture_compact"],
        ref: { kind: "architecture", revision: state.architecture.revision },
        orderKey: "ARCH",
        levels: architectureLevels(state.architecture),
        desiredDetail: architectureActiveScope ? "full" : "summary",
        minimumDetail: "summary",
        droppable: false,
      }),
    );
  }

  // L3 active scope (structural, by workflow scope) — planning mode only.
  const active = mode === "planning" ? resolveActiveSection(state) : undefined;
  if (active) fragments.push(...buildSectionScopeFragments(state, active));
  if (architectureActiveScope) fragments.push(...buildArchitectureScopeFragments(state));
  const synthesisFragment = mode === "planning" ? buildSynthesisScopeFragment(state) : undefined;
  if (synthesisFragment) fragments.push(synthesisFragment);
  // Discovery / architecture-before-artifact (brief §31): L3 is intentionally
  // sparse; questions/conflicts/evidence below still apply. Nothing fabricated.

  // Open questions: blocking = P0 everywhere; non-blocking only when
  // structurally relevant to the active scope (brief §25).
  if (mode === "planning") {
    for (const question of run.openQuestions) {
      if (question.status !== "open") continue;
      const relevant =
        question.blocking ||
        (!questionScopeIsArchitecture(question) &&
          active !== undefined &&
          (question.scope.id as SectionID) === active.id) ||
        (questionScopeIsArchitecture(question) && architectureActiveScope);
      if (!relevant) continue;
      fragments.push(
        makeFragment({
          id: `L3:question:${question.id}`,
          layer: "L3",
          priority: question.blocking ? "P0" : "P1",
          reason: "open_question",
          ref: { kind: "question", id: question.id },
          orderKey: question.id,
          levels: questionLevels(question),
          desiredDetail: "relevant",
          minimumDetail: question.blocking ? "summary" : "identity",
          droppable: !question.blocking,
        }),
      );
    }
  }

  // Conflicts: blocking = P0; warning only when structurally relevant.
  // Resolved conflicts are NEVER rendered as current blocking context
  // (brief §26) — each is recorded as an explicit, observable exclusion.
  const semanticExclusions: ContextTraceExcludedEntry[] = run.conflicts
    .filter((conflict) => conflict.status === "resolved")
    .map((conflict) => ({
      fragmentId: `L3:conflict:${conflict.id}`,
      ref: { kind: "conflict", id: conflict.id },
      layer: "L3" as const,
      reason: "resolved_conflict_not_current",
    }));
  if (mode === "planning") {
    for (const conflict of run.conflicts) {
      if (conflict.status === "resolved") continue;
      const relevant =
        conflict.severity === "blocking" || conflictScopeMatches(conflict, state, { active, architectureActiveScope });
      if (!relevant) continue;
      fragments.push(
        makeFragment({
          id: `L3:conflict:${conflict.id}`,
          layer: "L3",
          priority: conflict.severity === "blocking" ? "P0" : "P1",
          reason: "blocking_conflict",
          ref: { kind: "conflict", id: conflict.id },
          orderKey: conflict.id,
          levels: conflictLevels(conflict),
          desiredDetail: "relevant",
          minimumDetail: conflict.severity === "blocking" ? "summary" : "identity",
          droppable: conflict.severity !== "blocking",
        }),
      );
    }
  }

  // -- Evidence retrieval + L4 + explicit refs (planning mode only) -----------
  if (mode === "planning") {
    const evidenceCollector = new EvidenceCollector();

    // P0: Evidence for blocking questions/conflicts through representable
    // structural paths (scope artifact → exact decisions → evidence).
    for (const question of run.openQuestions) {
      if (question.status !== "open" || !question.blocking) continue;
      evidenceOfDecisions(evidenceCollector, state, decisionsForQuestionScope(state, question), "P0", "blocking_evidence");
    }
    for (const conflict of run.conflicts) {
      if (conflict.status !== "open" || conflict.severity !== "blocking") continue;
      evidenceOfDecisions(evidenceCollector, state, decisionsForConflictScope(state, conflict), "P0", "blocking_evidence");
    }

    // P1: Evidence referenced by ACTIVE decisions + Evidence directly scoped to
    // the active Section (the scope kind the model actually represents — brief §38).
    {
      const activeDecisions = fragments
        .filter((fragment) => fragment.id.startsWith("L3:decision:") || fragment.id.startsWith("L3:architecture-decision:"))
        .map((fragment) => fragment.ref)
        .filter((ref): ref is { kind: "decision"; id: DecisionID; revision: number } => ref?.kind === "decision")
        .map((ref) => state.decisions.get(`${ref.id}@${ref.revision}`))
        .filter((decision): decision is Decision => decision !== undefined);
      evidenceOfDecisions(evidenceCollector, state, activeDecisions, "P1", "active_decision_evidence");
      for (const record of state.evidence.values()) {
        if (active && record.scope.kind === "section" && record.scope.sectionID === active.id) {
          evidenceCollector.add(record, "P1", "active_section_evidence");
        }
      }
    }

    // P2: dependency + architecture Evidence through exact relationships.
    {
      const dependencyIDs = new Set<SectionID>([
        ...(active?.dependencies ?? []),
        ...(active ? transitiveDependencies(state, active.id) : []),
      ]);
      for (const record of state.evidence.values()) {
        if (record.scope.kind === "section" && dependencyIDs.has(record.scope.sectionID)) {
          evidenceCollector.add(record, "P2", "dependency_evidence");
        }
        if (record.scope.kind === "architecture" && state.architecture) {
          evidenceCollector.add(record, "P2", "architecture_evidence");
        }
      }
      if (state.architecture) {
        for (const id of state.architecture.basedOn) {
          const exact = currentDecisionByID(state, id);
          if (exact) evidenceOfDecisions(evidenceCollector, state, [exact], "P2", "architecture_evidence");
        }
      }
    }

    // P3: run-scoped supplementary Evidence — the first Evidence class dropped
    // under budget pressure (brief §40).
    for (const record of state.evidence.values()) {
      if (record.scope.kind === "run") {
        evidenceCollector.add(record, "P3", "active_scope");
      }
    }

    for (const retrieval of evidenceCollector.list()) {
      const priority = highestPriority(retrieval.priorities);
      fragments.push(
        makeFragment({
          id: `L3:evidence:${retrieval.evidence.id}@${retrieval.evidence.revision}`,
          layer: "L3",
          priority,
          reason: retrieval.reasons[0]!,
          reasons: retrieval.reasons,
          ref: { kind: "evidence", id: retrieval.evidence.id, revision: retrieval.evidence.revision },
          orderKey: `zz-evd-${retrieval.evidence.id}@${retrieval.evidence.revision}`,
          levels: evidenceLevels(retrieval.evidence),
          desiredDetail: "summary",
          minimumDetail: priority === "P0" ? "summary" : "identity",
          droppable: priority !== "P0",
        }),
      );
    }

    // Downstream impact summary (brief §27): deterministic from the current DAG;
    // statuses/validation only — downstream full design is never auto-loaded.
    if (active) {
      const { direct, transitive } = downstreamSections(state, active.id);
      if (direct.length > 0 || transitive.length > 0) {
        const identity = `Downstream impact of ${active.id}: ${direct.length} direct, ${transitive.length} transitive`;
        const summary = [
          identity,
          ...direct.map((section) => `- direct: ${section.id} [${section.status}] validation=${section.validation}`),
          ...transitive.map((section) => `- transitive: ${section.id} [${section.status}] validation=${section.validation}`),
        ].join("\n");
        fragments.push(
          makeFragment({
            id: `L3:downstream:${active.id}`,
            layer: "L3",
            priority: "P2",
            reason: "active_scope",
            orderKey: `zz-downstream-${active.id}`,
            levels: { identity, summary },
            desiredDetail: "summary",
            minimumDetail: "identity",
            droppable: true,
          }),
        );
      }
    }

    // -- L4 working context (brief §32/§33/§60/§61) -----------------------------
    const proposal = currentProposal(state);
    if (proposal) {
      const frozen = proposal.status === "awaiting_approval";
      const text = [
        `PROPOSAL ${proposal.id}@${proposal.revision} — WORKING STATE, NOT COMMITTED MEMORY.`,
        ...(frozen
          ? ["This Proposal is FROZEN for the approval decision; it is NOT committed until the Harness commits it after the explicit USER approval."]
          : []),
        projectProposalRelevant(proposal),
        `Status: ${proposal.status}${frozen ? " (awaiting the formal USER decision)" : ""}`,
      ].join("\n");
      fragments.push(
        makeFragment({
          id: `L4:proposal:${proposal.id}`,
          layer: "L4",
          priority: "P1",
          reason: "current_proposal",
          ref: { kind: "proposal", id: proposal.id, revision: proposal.revision },
          orderKey: proposal.id,
          levels: {
            identity: `${proposal.id}@${proposal.revision} [${proposal.status}] (WORKING — NOT committed)`,
            summary: text,
          },
          desiredDetail: "summary",
          minimumDetail: "identity",
          droppable: false,
        }),
      );
    }

    // Candidate question resolutions are WORKING state (brief §32).
    for (const question of run.openQuestions) {
      if (question.status !== "open" || !question.proposedResolution) continue;
      fragments.push(
        makeFragment({
          id: `L4:question-resolution:${question.id}`,
          layer: "L4",
          priority: "P2",
          reason: "open_question",
          ref: { kind: "question", id: question.id },
          orderKey: `zz-qres-${question.id}`,
          levels: {
            identity: `Candidate resolution for ${question.id} exists (WORKING — not committed)`,
            summary: `Candidate resolution for ${question.id} (WORKING — NOT committed): ${question.proposedResolution.text}`,
          },
          desiredDetail: "summary",
          minimumDetail: "identity",
          droppable: true,
        }),
      );
    }

    // -- Explicit reference upgrades (brief §57; frozen architecture §15) -------
    for (const ref of options.explicitRefs ?? []) {
      const fragment = fragmentForExplicitRef(state, ref);
      if (fragment) fragments.push(fragment);
    }
  }

  // -- L5 available operations (brief §34/§35) --------------------------------
  // Present in BOTH modes: handoff-status keeps the read-only checklist. L5 is
  // informational only — Controller/capability authorization remains the
  // server-side authority (brief §35).
  fragments.push(
    makeFragment({
      id: "L5:capabilities",
      layer: "L5",
      priority: "P0",
      reason: "capabilities",
      orderKey: "000",
      levels: { full: capabilityChecklistText(state) },
      desiredDetail: "full",
      minimumDetail: "full",
      droppable: false,
    }),
  );

  // -- Budget (frozen architecture §16; brief §44/§48) ------------------------
  const budgeted = applyBudget(fragments, budgetConfig.budgetTokens);
  if (budgeted.overBudget && budgetConfig.overflow === "fail") {
    throw new UltraPlanError(
      "context_budget_exceeded",
      `Required minimum planning context (${budgeted.totalTokens} estimated tokens) exceeds the configured Ultra Plan context budget (${budgetConfig.budgetTokens}); refusing to silently violate P0`,
      { budget: budgetConfig.budgetTokens, required: budgeted.totalTokens },
    );
  }

  // -- Render + trace ----------------------------------------------------------
  const rendered = renderContextBlock(state, budgeted.included);
  const totalTokens = estimateTokens(rendered);

  const included: ContextTraceIncludedEntry[] = budgeted.included.map((entry) => ({
    fragmentId: entry.fragment.id,
    ...(entry.fragment.ref !== undefined ? { ref: entry.fragment.ref } : {}),
    layer: entry.fragment.layer,
    priority: entry.fragment.priority,
    projection: entry.level,
    desiredDetail: entry.fragment.desiredDetail,
    reason: entry.fragment.reason,
    reasons: entry.fragment.reasons,
    estimatedTokens: entry.estimatedTokens,
    budgetDecision: entry.budgetDecision,
  }));
  const excluded: ContextTraceExcludedEntry[] = [
    ...budgeted.excluded.map((entry) => ({
      fragmentId: entry.fragment.id,
      ...(entry.fragment.ref !== undefined ? { ref: entry.fragment.ref } : {}),
      layer: entry.fragment.layer,
      reason: entry.reason,
    })),
    ...semanticExclusions,
  ];

  const trace: ContextTrace = {
    id: computeTraceId({
      planID: state.planID,
      headCommit: run.headCommit,
      stage: run.stage,
      activeWork: run.activeWork,
      budget: budgetConfig.budgetTokens,
      included: included.map((entry) => [entry.fragmentId, entry.projection, entry.budgetDecision]),
      excluded: excluded.map((entry) => [entry.fragmentId, entry.reason]),
    }) as ContextTraceID,
    planID: state.planID,
    ...(run.headCommit !== undefined ? { headCommit: run.headCommit } : {}),
    stage: run.stage,
    ...(run.activeWork !== undefined ? { activeWork: run.activeWork } : {}),
    included,
    excluded,
    budget: budgetConfig.budgetTokens,
    overBudget: budgeted.overBudget,
    totalTokens,
  };

  const warnings: string[] = [];
  if (budgeted.overBudget) {
    warnings.push(
      "context_budget_exceeded: required minimum context exceeded the configured budget; all required minimum content was rendered and the excess is recorded in the trace (P0 was never dropped)",
    );
  }

  return { rendered, trace, warnings };
}

// ---------------------------------------------------------------------------
// Explicit refs (brief §57) — deterministic projection of any exact ref
// ---------------------------------------------------------------------------

function fragmentForExplicitRef(state: PlanningContextState, ref: MemoryRef): ContextFragment | undefined {
  const base = {
    layer: "L3" as const,
    priority: "P1" as ContextPriority,
    reason: "explicit_reference" as const,
    desiredDetail: "full" as DetailLevel,
    droppable: false,
  };
  switch (ref.kind) {
    case "architecture": {
      const architecture = state.architecture;
      if (!architecture || (ref.revision !== undefined && ref.revision !== architecture.revision)) return undefined;
      return makeFragment({
        ...base,
        id: "L3:explicit:architecture",
        ref,
        orderKey: "zz-explicit-ARCH",
        levels: architectureLevels(architecture),
        minimumDetail: "summary",
      });
    }
    case "section": {
      const section = state.sections.find((s) => s.id === ref.id);
      if (!section) return undefined;
      const revision = ref.revision === undefined ? state.sectionRevisions.get(ref.id) : undefined;
      return makeFragment({
        ...base,
        id: `L3:explicit:section:${ref.id}${ref.revision !== undefined ? `@${ref.revision}` : ""}`,
        ref,
        orderKey: `zz-explicit-${ref.id}`,
        levels: revision
          ? {
              identity: projectSectionRevisionIdentity(revision),
              summary: projectSectionRevisionSummary(revision),
              relevant: projectSectionRevisionRelevant(revision),
              full: projectSectionRevisionFull(revision),
            }
          : {
              identity: projectSectionIdentity(section),
              summary: projectSectionSummary(section),
              relevant: projectSectionRelevant(section, {}),
            },
        minimumDetail: "identity",
      });
    }
    case "decision": {
      const decision = state.decisions.get(`${ref.id}@${ref.revision}`);
      if (!decision) return undefined;
      return makeFragment({
        ...base,
        id: `L3:explicit:decision:${decision.id}@${decision.revision}`,
        ref,
        orderKey: `zz-explicit-${decision.id}@${decision.revision}`,
        levels: decisionLevels(decision),
        minimumDetail: "summary",
      });
    }
    case "constraint": {
      const constraint = state.constraints.find((c) => c.id === ref.id);
      if (!constraint) return undefined;
      return makeFragment({
        ...base,
        id: `L3:explicit:constraint:${constraint.id}`,
        ref,
        orderKey: `zz-explicit-${constraint.id}`,
        levels: constraintLevels(constraint),
        minimumDetail: "identity",
      });
    }
    case "question": {
      const question = state.openQuestions.find((q) => q.id === ref.id);
      if (!question) return undefined;
      return makeFragment({
        ...base,
        id: `L3:explicit:question:${question.id}`,
        ref,
        orderKey: `zz-explicit-${question.id}`,
        levels: questionLevels(question),
        minimumDetail: "identity",
      });
    }
    case "conflict": {
      const conflict = state.conflicts.find((c) => c.id === ref.id);
      if (!conflict) return undefined;
      return makeFragment({
        ...base,
        id: `L3:explicit:conflict:${conflict.id}`,
        ref,
        orderKey: `zz-explicit-${conflict.id}`,
        levels: conflictLevels(conflict),
        minimumDetail: "identity",
      });
    }
    case "evidence": {
      const record = resolveEvidenceRef(state, ref);
      if (!record) return undefined;
      return makeFragment({
        ...base,
        id: `L3:explicit:evidence:${record.id}@${record.revision}`,
        ref: { kind: "evidence", id: record.id, revision: record.revision },
        orderKey: `zz-explicit-${record.id}@${record.revision}`,
        levels: evidenceLevels(record),
        minimumDetail: "identity",
      });
    }
    case "proposal": {
      const proposal = state.proposals.find((p) => p.id === ref.id);
      if (!proposal) return undefined;
      return makeFragment({
        ...base,
        id: `L3:explicit:proposal:${proposal.id}`,
        ref,
        orderKey: `zz-explicit-${proposal.id}`,
        levels: proposalLevels(proposal),
        minimumDetail: "identity",
      });
    }
    default:
      // snapshot/commit/final_plan refs stay reachable through plan_memory;
      // no deterministic full-projection upgrade is defined for them here.
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const LAYER_HEADERS: Record<ContextLayer, { header: string; footer: string }> = {
  L0: { header: "=== L0 PLANNING PROTOCOL ===", footer: "=== END L0 PLANNING PROTOCOL ===" },
  L1: { header: "=== L1 RUN STATE ===", footer: "=== END L1 RUN STATE ===" },
  L2: { header: "=== L2 GLOBAL COMMITTED MEMORY ===", footer: "=== END L2 GLOBAL COMMITTED MEMORY ===" },
  L3: { header: "=== L3 ACTIVE SCOPE ===", footer: "=== END L3 ACTIVE SCOPE ===" },
  L4: { header: "=== L4 CURRENT WORKING CONTEXT ===", footer: "=== END L4 CURRENT WORKING CONTEXT ===" },
  L5: { header: "=== L5 AVAILABLE OPERATIONS ===", footer: "=== END L5 AVAILABLE OPERATIONS ===" },
};

/** The committed-vs-working separation is explicit and pinned (brief §60). */
export const COMMITTED_MEMORY_NOTE = "Everything below is COMMITTED Plan Memory: approved, immutable, exact revisions.";
export const WORKING_CONTEXT_NOTE = "Everything in this section is WORKING STATE — NOT committed memory.";

function renderContextBlock(
  state: PlanningContextState,
  included: { fragment: ContextFragment; text: string }[],
): string {
  const head = state.run.headCommit ?? "none";
  const lines: string[] = [`<ULTRA_PLAN_CONTEXT plan="${state.planID}" head="${head}" stage="${state.run.stage}">`];
  for (const layer of ["L0", "L1", "L2", "L3", "L4", "L5"] as const) {
    const entries = included.filter((entry) => entry.fragment.layer === layer);
    if (entries.length === 0) continue;
    lines.push(LAYER_HEADERS[layer].header);
    if (layer === "L2") lines.push(COMMITTED_MEMORY_NOTE);
    if (layer === "L4") lines.push(WORKING_CONTEXT_NOTE);
    for (const entry of entries) {
      lines.push(entry.text);
    }
    lines.push(LAYER_HEADERS[layer].footer);
  }
  lines.push("</ULTRA_PLAN_CONTEXT>");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Observability (brief §72/§73) — structured, secret-free trace logging
// ---------------------------------------------------------------------------

/** The exact structured diagnostic entry the live smoke can parse. */
export function renderTraceLog(trace: ContextTrace): string {
  return JSON.stringify({
    channel: "ultraplan.context.trace",
    id: trace.id,
    planID: trace.planID,
    headCommit: trace.headCommit,
    stage: trace.stage,
    activeWork: trace.activeWork,
    budget: trace.budget,
    overBudget: trace.overBudget,
    totalTokens: trace.totalTokens,
    included: trace.included.map((entry) => ({
      fragmentId: entry.fragmentId,
      ref: entry.ref,
      layer: entry.layer,
      priority: entry.priority,
      projection: entry.projection,
      reason: entry.reason,
      estimatedTokens: entry.estimatedTokens,
      budgetDecision: entry.budgetDecision,
    })),
    excluded: trace.excluded,
  });
}

/** Latest-trace diagnostic cache (brief §53): bounded, ephemeral, NON-authoritative. */
const latestTraces = new Map<PlanID, ContextTrace>();
const LATEST_TRACE_LIMIT = 8;

export function recordLatestTrace(trace: ContextTrace): void {
  latestTraces.set(trace.planID, trace);
  if (latestTraces.size > LATEST_TRACE_LIMIT) {
    const oldest = latestTraces.keys().next().value;
    if (oldest !== undefined) latestTraces.delete(oldest);
  }
}

export function getLatestContextTrace(planID: PlanID): ContextTrace | undefined {
  return latestTraces.get(planID);
}

export function clearLatestContextTraces(): void {
  latestTraces.clear();
}

/** Unused-type re-export guard (EvidenceScope is part of the retrieval contract surface). */
export type { EvidenceScope };
