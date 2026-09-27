/**
 * Deterministic projection registry — frozen architecture §15 + R2 brief
 * §8/§9/§10/§41/§49.
 *
 * Every projection here is a PURE function of the approved artifact: no model
 * call, no clock, no randomness. Where an approved STABLE projection already
 * exists (SectionRevision.projection.compact, SectionContract), it is the
 * canonical `summary`/contract representation verbatim — approved design is
 * never re-summarized (§17). Where none exists (Architecture, Decision,
 * Evidence, …), the projection is a deterministic structured render of the
 * approved fields.
 *
 * Compression NEVER truncates text mid-field (brief §50): a lower detail level
 * is a different structured projection, not a sliced string.
 */
import type { Decision, Architecture, Section, SectionRevision, SectionContract, Constraint, OpenQuestion, Conflict, InterfaceSpec, InterfaceRef } from "../core/types.js";
import type { DetailLevel } from "./trace.js";
import type { Evidence } from "../repository/evidence.js";
import type { Proposal } from "../transaction/types.js";

function lines(...parts: (string | false | undefined | null)[]): string {
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join("\n");
}

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

// ---------------------------------------------------------------------------
// Architecture (brief §9: deterministic structured compact projection)
// ---------------------------------------------------------------------------

/** ARCH@n + status + one-line summary. */
export function projectArchitectureIdentity(architecture: Architecture): string {
  return `ARCH@${architecture.revision} [${architecture.status}] ${architecture.summary.split("\n")[0]}`;
}

/**
 * The deterministic structured COMPACT projection (§9): summary + component
 * names/summaries + boundary/data-flow/principle lists. This is the required
 * non-droppable L2 minimum (brief §16 resolution).
 */
export function projectArchitectureSummary(architecture: Architecture): string {
  const parts = [`ARCH@${architecture.revision} [${architecture.status}]`];
  parts.push(`Summary: ${architecture.summary}`);
  if (architecture.components.length > 0) {
    parts.push("Components:");
    parts.push(bullets(architecture.components.map((component) => `${component.name}: ${component.summary}`)));
  }
  if (architecture.boundaries.length > 0) {
    parts.push("Boundaries:");
    parts.push(bullets(architecture.boundaries.map((boundary) => `${boundary.name}: ${boundary.description}`)));
  }
  if (architecture.dataFlows.length > 0) {
    parts.push("Data flows:");
    parts.push(bullets(architecture.dataFlows.map((flow) => `${flow.from} -> ${flow.to}: ${flow.description}`)));
  }
  if (architecture.principles.length > 0) {
    parts.push("Principles:");
    parts.push(bullets(architecture.principles.map((principle) => principle.statement)));
  }
  return parts.join("\n");
}

/** The relevant level adds the exact design provenance (basedOn + unresolved questions). */
export function projectArchitectureRelevant(architecture: Architecture, unresolvedQuestionIds: readonly string[]): string {
  return lines(
    projectArchitectureSummary(architecture),
    ...(architecture.basedOn.length > 0 ? [`Based on decisions: ${architecture.basedOn.join(", ")}`] : []),
    ...(unresolvedQuestionIds.length > 0 ? [`Unresolved questions: ${unresolvedQuestionIds.join(", ")}`] : []),
  );
}

/** Full adds the unresolved question records verbatim (approved structured artifact). */
export function projectArchitectureFull(architecture: Architecture): string {
  const unresolved =
    architecture.unresolved.length > 0
      ? lines(
          "Unresolved questions carried by the approved Architecture:",
          bullets(
            architecture.unresolved.map(
              (question) => `${question.id}${question.blocking ? " [blocking]" : ""} (${question.status}): ${question.question}`,
            ),
          ),
        )
      : "";
  return lines(projectArchitectureRelevant(architecture, architecture.unresolved.map((q) => q.id)), unresolved);
}

// ---------------------------------------------------------------------------
// Section root + SectionRevision + SectionContract
// ---------------------------------------------------------------------------

export function projectSectionIdentity(section: Section): string {
  return `${section.id} [${section.status}] validation=${section.validation}`;
}

export function projectSectionSummary(section: Section): string {
  return lines(projectSectionIdentity(section), `${section.title}: ${section.objective}`);
}

/** Relevant adds the structural position (dependencies + revision pointers). */
export function projectSectionRelevant(
  section: Section,
  extra: { revisionState?: string } = {},
): string {
  return lines(
    projectSectionSummary(section),
    ...(section.dependencies.length > 0 ? [`Depends on: ${section.dependencies.join(", ")}`] : ["Depends on: none"]),
    ...(extra.revisionState !== undefined ? [extra.revisionState] : []),
  );
}

/** SEC-###@n + status — the identity projection of an immutable revision. */
export function projectSectionRevisionIdentity(revision: SectionRevision): string {
  return `${revision.sectionID}@${revision.revision} [${revision.status}]`;
}

/**
 * The APPROVED compact projection is the canonical summary — the exact stable
 * projection the user approved (§17), never a re-summary.
 */
export function projectSectionRevisionSummary(revision: SectionRevision): string {
  return `${revision.sectionID}@${revision.revision} compact projection:\n${revision.projection.compact}`;
}

/** Relevant adds the structurally selected fields: problem, decisions, questions, dependencies, impacts. */
export function projectSectionRevisionRelevant(revision: SectionRevision): string {
  return lines(
    projectSectionRevisionSummary(revision),
    `Problem: ${revision.problem}`,
    ...(revision.dependencies.length > 0
      ? [
          "Dependencies:",
          bullets(
            revision.dependencies.map(
              (dependency) =>
                `${dependency.sectionID}${dependency.contractRevision !== undefined ? `@contract${dependency.contractRevision}` : ""} consumes: ${dependency.consumes.join(", ") || "—"}`,
            ),
          ),
        ]
      : []),
    ...(revision.decisions.length > 0 ? [`Decisions: ${revision.decisions.join(", ")}`] : []),
    ...(revision.openQuestions.length > 0 ? [`Open questions: ${revision.openQuestions.join(", ")}`] : []),
    ...(revision.impacts.length > 0 ? [`Impacts: ${revision.impacts.join(", ")}`] : []),
  );
}

/** Full renders the complete approved structured artifact (safe representation). */
export function projectSectionRevisionFull(revision: SectionRevision): string {
  return lines(
    projectSectionRevisionRelevant(revision),
    `Design:\n${revision.design}`,
    ...(revision.interfaces.length > 0
      ? [
          "Interfaces:",
          bullets(
            revision.interfaces.map(
              (spec) => `${spec.name}${spec.signature ? `: ${spec.signature}` : `: ${spec.description}`}`,
            ),
          ),
        ]
      : []),
    ...(revision.invariants.length > 0 ? ["Invariants:", bullets(revision.invariants)] : []),
    ...(revision.failureModes.length > 0
      ? [
          "Failure modes:",
          bullets(revision.failureModes.map((mode) => `${mode.description}${mode.mitigation ? ` (mitigation: ${mode.mitigation})` : ""}`)),
        ]
      : []),
    `Approved at revision ${revision.revision}.`,
  );
}

// ---------------------------------------------------------------------------
// SectionContract — the approved contract projection is used verbatim
// ---------------------------------------------------------------------------

export function projectSectionContract(contract: SectionContract): string {
  return lines(
    `CONTRACT ${contract.sectionID}@${contract.revision}`,
    ...(contract.provides.length > 0 ? [`Provides: ${contract.provides.join("; ")}`] : []),
    ...(contract.requires.length > 0 ? [`Requires: ${contract.requires.join("; ")}`] : []),
    ...(contract.invariants.length > 0 ? [`Invariants: ${contract.invariants.join("; ")}`] : []),
    ...(contract.interfaces.length > 0
      ? [`Interfaces: ${contract.interfaces.map((ref) => `${ref.name}${ref.providedBy ? ` (provided by ${ref.providedBy})` : ""}`).join("; ")}`]
      : []),
    ...(contract.decisions.length > 0
      ? [`Decisions: ${contract.decisions.map((ref) => `${ref.id}@${ref.revision}`).join(", ")}`]
      : []),
  );
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export function projectDecisionIdentity(decision: Decision): string {
  return `${decision.id}@${decision.revision} [${decision.status}] ${decision.title}`;
}

export function projectDecisionSummary(decision: Decision): string {
  return lines(projectDecisionIdentity(decision), decision.statement);
}

export function projectDecisionRelevant(decision: Decision): string {
  const scope = decision.scope.architecture
    ? "architecture"
    : decision.scope.sections && decision.scope.sections.length > 0
      ? `sections ${decision.scope.sections.join(", ")}`
      : "unscoped";
  return lines(projectDecisionSummary(decision), `Rationale: ${decision.rationale}`, `Scope: ${scope}`);
}

export function projectDecisionFull(decision: Decision): string {
  return lines(
    projectDecisionRelevant(decision),
    ...(decision.alternatives && decision.alternatives.length > 0
      ? [
          "Alternatives rejected:",
          bullets(
            decision.alternatives.map(
              (alternative) => `${alternative.description}${alternative.rejectedBecause ? ` — ${alternative.rejectedBecause}` : ""}`,
            ),
          ),
        ]
      : []),
    ...(decision.consequences && decision.consequences.length > 0 ? ["Consequences:", bullets(decision.consequences)] : []),
    ...(decision.evidence && decision.evidence.length > 0
      ? [`Evidence: ${decision.evidence.map((ref) => `${ref.id}${ref.revision !== undefined ? `@${ref.revision}` : ""}`).join(", ")}`]
      : []),
    ...(decision.supersedes ? [`Supersedes: ${decision.supersedes.id}@${decision.supersedes.revision}`] : []),
  );
}

// ---------------------------------------------------------------------------
// Constraint — hard/active minimum is exact ID + statement (brief §49)
// ---------------------------------------------------------------------------

export function projectConstraintIdentity(constraint: Constraint): string {
  return `${constraint.id} [${constraint.severity}/${constraint.status}]`;
}

export function projectConstraintSummary(constraint: Constraint): string {
  return `${constraint.id} [${constraint.severity}/${constraint.status}] ${constraint.statement}`;
}

export function projectConstraintRelevant(constraint: Constraint): string {
  return `${projectConstraintSummary(constraint)} (source: ${constraint.source})`;
}

// ---------------------------------------------------------------------------
// Question / Conflict — blocking minimums per brief §49
// ---------------------------------------------------------------------------

export function projectQuestionIdentity(question: OpenQuestion): string {
  // OpenQuestion.scope is ArchitectureRef | SectionRef — the Architecture
  // singleton is pinned to the literal id "ARCH", so identity is the discriminator.
  const scope = question.scope.id === "ARCH" ? "ARCH" : question.scope.id;
  return `${question.id} [${question.status}${question.blocking ? "/blocking" : ""}] scope=${scope}`;
}

/** Blocking minimum: exact ID + FULL question + scope + status (brief §49). */
export function projectQuestionSummary(question: OpenQuestion): string {
  return lines(projectQuestionIdentity(question), `Q: ${question.question}`);
}

export function projectQuestionRelevant(question: OpenQuestion): string {
  return lines(
    projectQuestionSummary(question),
    ...(question.proposedResolution
      ? [`Candidate resolution (WORKING STATE — not committed): ${question.proposedResolution.text}`]
      : []),
    ...(question.resolvedBy ? [`Resolved by: ${question.resolvedBy}`] : []),
  );
}

export function projectConflictIdentity(conflict: Conflict): string {
  return `${conflict.id} [${conflict.severity}/${conflict.status}] type=${conflict.type}`;
}

/** Blocking minimum: ID + description + refs + status (brief §49). */
export function projectConflictSummary(conflict: Conflict): string {
  const refs = conflict.refs.map(renderMemoryRefCompact).join(", ");
  return lines(projectConflictIdentity(conflict), conflict.description, ...(refs ? [`Refs: ${refs}`] : []));
}

export function projectConflictRelevant(conflict: Conflict): string {
  return lines(
    projectConflictSummary(conflict),
    ...(conflict.resolution
      ? [`Resolution: ${conflict.resolution.action} -> ${renderMemoryRefCompact(conflict.resolution.ref)}`]
      : []),
  );
}

// ---------------------------------------------------------------------------
// Evidence — compact form conceptually: EVD-037@2 [fresh/direct/critical] …
// ---------------------------------------------------------------------------

export function projectEvidenceIdentity(evidence: Evidence): string {
  return `${evidence.id}@${evidence.revision}`;
}

export function projectEvidenceSummary(evidence: Evidence): string {
  const state = `${evidence.freshness}/${evidence.confidence}/${evidence.criticality}`;
  const status = evidence.status === "active" ? "" : ` status=${evidence.status}`;
  return lines(`${evidence.id}@${evidence.revision} [${state}]${status}`, `Claim: ${evidence.claim}`, renderEvidenceSource(evidence));
}

function renderEvidenceSource(evidence: Evidence): string {
  const sources = evidence.source.map((source) => {
    switch (source.type) {
      case "file":
        return `file ${source.path ?? "?"}${source.range ? ` (L${source.range.startLine}-L${source.range.endLine})` : ""}`;
      case "symbol":
        return `symbol ${source.path ? `${source.path}::` : ""}${source.symbol ?? "?"}`;
      case "command":
        return `command: ${source.command ?? "?"}`;
      case "test":
        return `test: ${source.command ?? source.path ?? "?"}`;
      case "package_metadata":
        return `package metadata${source.path ? ` ${source.path}` : ""}`;
      case "runtime":
        return `runtime: ${source.command ?? "?"}`;
    }
  });
  return `Source: ${sources.join("; ") || "unrecorded"}`;
}

// ---------------------------------------------------------------------------
// Proposal (working context — L4)
// ---------------------------------------------------------------------------

export function projectProposalIdentity(proposal: Proposal): string {
  return `${proposal.id}@${proposal.revision} [${proposal.status}] ${proposal.type}`;
}

export function projectProposalSummary(proposal: Proposal): string {
  return lines(
    projectProposalIdentity(proposal),
    `Title: ${proposal.title}`,
    `Summary: ${proposal.summary}`,
    `Scope: ${proposal.scope.id === "ARCH" ? "ARCH" : proposal.scope.id}`,
    ...(proposal.hash ? [`Hash: ${proposal.hash}`] : []),
    `Changes: ${proposal.changes.length}`,
  );
}

export function projectProposalRelevant(proposal: Proposal): string {
  return lines(
    projectProposalSummary(proposal),
    "Change summary:",
    bullets(
      proposal.changes.map((change) => {
        switch (change.kind) {
          case "add_decision":
          case "amend_decision":
            return `${change.kind}: ${change.decision.id}@${change.decision.revision} — ${change.decision.title}`;
          case "add_section_revision":
            return `add_section_revision: ${change.revision.sectionID}@${change.revision.revision}`;
          case "amend_section":
            return `amend_section: ${change.revision.sectionID}@${change.revision.revision} (supersedes ${change.supersedes.revision})`;
          case "add_architecture":
            return `add_architecture: ARCH@${change.architecture.revision}`;
          case "amend_architecture":
            return `amend_architecture: ARCH@${change.architecture.revision} (supersedes ${change.supersedes.revision})`;
          case "add_constraint":
            return `add_constraint: ${change.constraint.id} [${change.constraint.severity}] ${change.constraint.statement}`;
          case "add_section":
            return `add_section: ${change.section.id} — ${change.section.title}`;
          case "select_initial_section":
            return `select_initial_section: ${change.section.id}`;
          case "raise_question":
            return `raise_question: ${change.question.id}${change.question.blocking ? " [blocking]" : ""}`;
          case "resolve_question":
            return `resolve_question: ${change.resolution.questionID}`;
          case "complete_architecture":
            return `complete_architecture: ARCH@${change.target.revision}`;
          case "complete_section":
            return `complete_section: ${change.target.id}@${change.target.revision}`;
          case "reopen_section":
            return `reopen_section: ${change.target.id}@${change.target.revision} (${change.reason.type})`;
          case "reopen_architecture":
            return `reopen_architecture: ARCH@${change.target.revision} (${change.reason.type})`;
          case "resolve_conflict":
            return `resolve_conflict: ${change.conflictID} (${change.resolution.action})`;
          case "add_final_plan":
            return `add_final_plan: FINAL@${change.finalPlan.revision}`;
        }
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Interfaces (brief §24: smallest useful structured form)
// ---------------------------------------------------------------------------

export function projectInterfaceSpec(spec: InterfaceSpec): string {
  return lines(`${spec.name}${spec.signature ? `: ${spec.signature}` : ""}`, ...(spec.signature ? [spec.description] : []));
}

export function projectInterfaceRef(ref: InterfaceRef): string {
  return `${ref.name}${ref.providedBy ? ` (provided by ${ref.providedBy})` : ""}`;
}

// ---------------------------------------------------------------------------
// MemoryRef compact rendering (used in projections and trace-free contexts)
// ---------------------------------------------------------------------------

export function renderMemoryRefCompact(ref: {
  kind: string;
  id?: string;
  revision?: number;
}): string {
  switch (ref.kind) {
    case "architecture":
      return `ARCH@${ref.revision ?? "?"}`;
    case "section":
      return `${ref.id}${ref.revision !== undefined ? `@${ref.revision}` : ""}`;
    case "decision":
      return `${ref.id}${ref.revision !== undefined ? `@${ref.revision}` : ""}`;
    case "constraint":
    case "question":
    case "conflict":
    case "evidence":
    case "proposal":
    case "snapshot":
    case "commit":
    case "final_plan":
      return `${ref.id}${ref.revision !== undefined ? `@${ref.revision}` : ""}`;
    default:
      return String(ref.kind);
  }
}

/** The DetailLevel → renderer wiring per artifact family is owned by the assembler. */
export type ProjectionFamily =
  | "architecture"
  | "section"
  | "section_revision"
  | "section_contract"
  | "decision"
  | "constraint"
  | "question"
  | "conflict"
  | "evidence"
  | "proposal";

export function detailLevelAtLeast(actual: DetailLevel, minimum: DetailLevel): boolean {
  const order: DetailLevel[] = ["full", "relevant", "summary", "identity"];
  return order.indexOf(actual) <= order.indexOf(minimum);
}
