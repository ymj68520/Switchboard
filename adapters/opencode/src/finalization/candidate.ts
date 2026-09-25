/**
 * Deterministic FinalPlanCandidate assembly + preview (Phase 2H brief §31-§46).
 *
 * NO MODEL CALL (brief §32): the planning model already produced Synthesis,
 * the isolated validator already judged it, the audit already classified the
 * reachable evidence — the candidate is ASSEMBLED from those four authority
 * objects. Implementation order and limitations are EXACT copies of the
 * validated manifest (§33/§34 — never regenerated, never silently dropped);
 * decisions/constraints/sections bind exact committed refs (§35/§36 — never
 * "latest"). No new normative prose is created.
 */
import type { SynthesisInput, SynthesisManifest } from "../synthesis/types.js";
import type {
  CandidateValidationSummary,
  FinalizationIdentity,
  FinalPlanCandidate,
  FinalPlanCandidateDraft,
} from "./types.js";

export interface AssembleCandidateDeps {
  identity: FinalizationIdentity;
  input: SynthesisInput;
  manifest: SynthesisManifest;
}

/**
 * Assemble the candidate DRAFT for an exact passing gate identity (pure).
 * id/revision/createdAt/hash are Harness/store-assigned in-lock so concurrent
 * finalization requests converge on ONE candidate revision (brief §38/§73).
 */
export function assembleFinalPlanCandidate(deps: AssembleCandidateDeps): FinalPlanCandidateDraft {
  const { identity, input, manifest } = deps;
  const validation: CandidateValidationSummary = {
    blockingQuestions: 0,
    blockingConflicts: 0,
    invalidSections: 0,
    semanticValidation: "clean",
    evidenceAudit: "pass",
  };
  return {
    planID: input.planID,
    baseSnapshot: identity.headSnapshot,
    baseCommit: identity.headCommit,
    architecture: identity.architecture,
    // Exact approved Section revisions in the input's canonical DAG order.
    sections: input.sections.map((section) => ({ ...section.ref })),
    // Exact committed Decision revisions HEAD binds (§35 — never "latest").
    decisions: input.decisions.map((decision) => ({ ...decision })),
    // Committed constraints only (§36) — the input already froze exactly those.
    constraints: input.constraints.map((constraint) => ({ ...constraint })),
    synthesisInput: { id: input.id, hash: input.hash },
    synthesisManifest: { id: manifest.id, revision: manifest.revision, hash: manifest.hash },
    semanticValidation: { reportID: identity.validationReport.id, hash: identity.validationReport.hash },
    evidenceAudit: { id: identity.evidenceAudit.id, hash: identity.evidenceAudit.hash },
    // §33/§34: EXACT copies of the validated manifest content — order numbers
    // are the Harness-derived `order` values; nothing is reordered or dropped.
    implementationOrder: manifest.implementationOrder.map((step) => ({ ...step })),
    limitations: manifest.limitations.map((limitation) => ({ ...limitation })),
    validation,
  };
}

/**
 * The candidate identity (brief §38) — the exact successful gate inputs a
 * candidate (or draft) binds. Identical identity ⇒ idempotent retrieval of
 * the same candidate; any component change ⇒ a new candidate revision.
 */
export function candidateRecordIdentity(record: {
  baseSnapshot: { id: string };
  baseCommit: unknown;
  architecture: unknown;
  synthesisInput: { id: string; hash: string };
  synthesisManifest: { id: string; revision: number; hash: string };
  semanticValidation: { reportID: string; hash: string };
  evidenceAudit: { id: string; hash: string };
}): { headSnapshot: string; inputHash: string; manifestHash: string; reportHash: string; auditHash: string } {
  return {
    headSnapshot: record.baseSnapshot.id,
    inputHash: record.synthesisInput.hash,
    manifestHash: record.synthesisManifest.hash,
    reportHash: record.semanticValidation.hash,
    auditHash: record.evidenceAudit.hash,
  };
}

/**
 * Deterministic human-readable preview (brief §43). Rendered from the
 * structured candidate only — never model-generated, never canonical state
 * (§44: the structured candidate is authoritative; any Markdown is a
 * projection).
 */
export function renderFinalPlanCandidatePreview(candidate: FinalPlanCandidate): string {
  const lines: string[] = [
    "Final Plan Candidate",
    "",
    `Base: ${candidate.baseSnapshot.id}`,
    `Base commit: ${candidate.baseCommit ?? "none"}`,
    "",
    `Architecture: ARCH@${candidate.architecture.revision}`,
    "",
    "Sections:",
    ...(candidate.sections.length > 0
      ? candidate.sections.map((section) => `  ${section.id}@${section.revision}`)
      : ["  (none)"]),
    "",
    "Implementation order:",
    ...(candidate.implementationOrder.length > 0
      ? candidate.implementationOrder.map((step) => `  ${step.order}. ${step.title} — ${step.description}`)
      : ["  (none)"]),
    "",
    "Committed decisions:",
    ...(candidate.decisions.length > 0
      ? candidate.decisions.map((decision) => `  ${decision.id}@${decision.revision}`)
      : ["  (none)"]),
    "",
    "Hard / active constraints:",
    ...(candidate.constraints.filter((constraint) => constraint.status === "active").length > 0
      ? candidate.constraints
          .filter((constraint) => constraint.status === "active")
          .map((constraint) => `  [${constraint.severity}] ${constraint.statement}`)
      : ["  (none)"]),
    "",
    "Known limitations:",
    ...(candidate.limitations.length > 0
      ? candidate.limitations.map((limitation) => `  - ${limitation.statement}`)
      : ["  (none)"]),
    "",
    `Semantic validation: clean / ${candidate.semanticValidation.reportID}`,
    `Evidence audit: pass / ${candidate.evidenceAudit.id}`,
    `Candidate: ${candidate.id}@${candidate.revision}`,
    `Candidate hash: ${candidate.hash}`,
    "",
    "This candidate is NOT user-approved. It does NOT authorize Build.",
    "Formal Final Approval is a later workflow; the stage remains synthesis.",
  ];
  return lines.join("\n");
}
