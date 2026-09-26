/**
 * Finalization / Final Plan canonical models (Phase 13 §6–§14/§30–§36/§52–§57).
 *
 * PURE core: vocabulary, canonical shapes, deterministic hashing, structural
 * validation, and the deterministic FinalizationGate. No SQLite, no host, no
 * filesystem, no MCP (§12 — hashes/fingerprints/queries stay in Application).
 *
 * Authority model (§1): a clean validator report is NOT finalization; the
 * FinalizationGate is Core-only deterministic authority over the whole
 * current planning world; the user authorizes one exact frozen final_plan
 * Proposal; the Final PlanCommit is the only committed authorization
 * transaction. The gate runs TWICE — once to freeze a FinalPlanCandidate and
 * once more at Final Approval — and the second run NEVER trusts the first
 * (§2/§3): no pass verdict is ever cached as commit authority.
 *
 * Canonical identity (§32/§57): candidate and FinalPlan hashes cover the
 * semantic payload only. Server-generated identity (candidate id, FinalPlan
 * id, timestamps, audit event seqs) is excluded, so a semantically equal
 * candidate re-derived from the same frozen world hashes identically.
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";
import type { DerivedStatement, ImplementationStep } from "./synthesis.js";

export const FINALIZATION_AUDIT_VERSION = 1 as const;
export const FINAL_PLAN_CANDIDATE_VERSION = 1 as const;
export const FINAL_PLAN_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// §13/§14 — FinalizationDecision and the structured reason vocabulary
// ---------------------------------------------------------------------------

/**
 * The frozen FinalizationGate deny vocabulary (§14). Every deny carries
 * structured reasons — never a boolean, never natural-language parsing.
 */
export const FINALIZATION_REASON_CODES = [
  "HEAD_STALE",
  "SYNTHESIS_INPUT_MISSING",
  "SYNTHESIS_INPUT_STALE",
  "SYNTHESIS_MANIFEST_MISSING",
  "SYNTHESIS_MANIFEST_INVALID",
  "SEMANTIC_VALIDATION_MISSING",
  "SEMANTIC_VALIDATION_NOT_CLEAN",

  "ARCHITECTURE_MISSING",
  "SECTION_INCOMPLETE",
  "SECTION_NEEDS_REVIEW",
  "ACTIVE_SECTION_PRESENT",

  "BLOCKING_QUESTION",
  "BLOCKING_CONFLICT",

  "SYNTHESIS_FINDINGS_UNRESOLVED",

  "EVIDENCE_CRITICAL_NOT_FRESH",
  "EVIDENCE_SUPPORTING_NEEDS_VALIDATION",

  "AWAITING_PROPOSAL_EXISTS",

  "EVIDENCE_AUDIT_FAILED",
] as const;

export type FinalizationReasonCode = (typeof FINALIZATION_REASON_CODES)[number];

/** One structured deny reason: a stable code plus machine-readable facts. */
export interface FinalizationReason {
  code: FinalizationReasonCode;
  detail?: Record<string, unknown>;
}

export type FinalizationDecision =
  | { status: "pass" }
  | { status: "deny"; reasons: FinalizationReason[] };

/** True when every current HEAD member is the exact revision the input pinned. */
export interface FinalizationWorldSection {
  sectionId: string;
  revision: number;
  status: "open" | "completed" | "needs_review";
  completedRevision: number | null;
}

/** Current freshness of one exact Evidence revision in the audited scope (§8). */
export interface FinalizationEvidenceFact {
  evidenceId: string;
  revision: number;
  criticality: "critical" | "supporting" | "informational";
  validationStrategy: "fingerprint" | "reobserve";
  /** The materialized state AFTER audit-time deterministic revalidation. */
  state: "fresh" | "needs_validation" | "stale" | "invalidated" | null;
  /** §10 — a reobserve revision needing re-observation can never pass. */
  requiresReobservation: boolean;
}

/**
 * FinalizationFacts (§12): everything the pure gate judges, pre-loaded by the
 * Application layer from the authoritative Store. The gate itself performs NO
 * I/O — the same evaluator serves the pre-approval request and the
 * post-authorization rerun.
 */
export interface FinalizationFacts {
  run: { lifecycle: string; stage: string; revision: number };
  head: { snapshotId: string | null; commitId: string | null };
  /** The exact synthesis chain the run currently presents (§17). */
  synthesis: {
    inputId: string;
    inputHash: string;
    baseHeadSnapshot: string;
    baseHeadCommit: string | null;
    manifestId: string | null;
    manifestHash: string | null;
    reportId: string | null;
    reportHash: string | null;
    reportIsClean: boolean | null;
    unresolvedFindingCount: number;
  } | null;
  /** The CURRENT HEAD architecture and the one the input pinned (§20). */
  architecture: { id: string; revision: number } | null;
  pinnedArchitecture: { id: string; revision: number } | null;
  /** Every current HEAD Section joined to its workflow state (§21). */
  sections: FinalizationWorldSection[];
  activeSection: string | null;
  blockingQuestionCount: number;
  blockingConflictCount: number;
  /** Current states over the frozen input's exact Evidence scope (§7/§9). */
  evidence: FinalizationEvidenceFact[];
  /** The recomputed committed-design reachability equals the frozen scope (§7). */
  evidenceScopeMatches: boolean;
  /** An ordinary (non-final) Proposal is still awaiting (§14). */
  awaitingProposal: { proposalId: string; type: string } | null;
}

/**
 * The FinalizationGate (§2/§12/§15–§24): deterministic, exhaustive, ordered
 * exactly so each deny reason pinpoints the first broken layer. Pure — the
 * SAME function judges request_finalization and the post-authorization rerun.
 */
export function evaluateFinalization(facts: FinalizationFacts): FinalizationDecision {
  const reasons: FinalizationReason[] = [];
  const deny = (): FinalizationDecision => ({ status: "deny", reasons });

  // §16 — HEAD must still be the input's base pair; an old synthesis is never
  // re-bound to a new HEAD.
  if (facts.synthesis === null) {
    reasons.push({ code: "SYNTHESIS_INPUT_MISSING" });
    return deny();
  }
  const headMatches =
    facts.head.snapshotId === facts.synthesis.baseHeadSnapshot &&
    (facts.head.commitId ?? null) === facts.synthesis.baseHeadCommit;
  if (!headMatches) {
    reasons.push({
      code: "HEAD_STALE",
      detail: {
        baseHeadSnapshot: facts.synthesis.baseHeadSnapshot,
        baseHeadCommit: facts.synthesis.baseHeadCommit,
        headSnapshot: facts.head.snapshotId,
        headCommit: facts.head.commitId,
      },
    });
    return deny();
  }

  // §17 — the exact Input → Manifest → Report chain.
  if (facts.synthesis.manifestId === null || facts.synthesis.manifestHash === null) {
    reasons.push({ code: "SYNTHESIS_MANIFEST_MISSING", detail: { inputId: facts.synthesis.inputId } });
  }
  if (facts.synthesis.reportId === null || facts.synthesis.reportHash === null) {
    reasons.push({ code: "SEMANTIC_VALIDATION_MISSING", detail: { manifestId: facts.synthesis.manifestId } });
  } else if (facts.synthesis.reportIsClean !== true) {
    // §18 — isClean, not merely "a report exists".
    reasons.push({ code: "SEMANTIC_VALIDATION_NOT_CLEAN", detail: { reportId: facts.synthesis.reportId } });
  }

  // §19 — the frozen architecture forbids unresolved synthesis findings even
  // under a clean validator report.
  if (facts.synthesis.unresolvedFindingCount > 0) {
    reasons.push({
      code: "SYNTHESIS_FINDINGS_UNRESOLVED",
      detail: { count: facts.synthesis.unresolvedFindingCount },
    });
  }

  // §20 — exactly one Architecture at HEAD, and it must be the pinned one.
  if (facts.architecture === null) {
    reasons.push({ code: "ARCHITECTURE_MISSING" });
  } else if (
    facts.pinnedArchitecture !== null &&
    (facts.architecture.id !== facts.pinnedArchitecture.id ||
      facts.architecture.revision !== facts.pinnedArchitecture.revision)
  ) {
    reasons.push({
      code: "ARCHITECTURE_MISSING",
      detail: { current: facts.architecture, pinned: facts.pinnedArchitecture },
    });
  }

  // §21 — every current Section completed at its exact HEAD revision.
  if (facts.sections.length === 0) {
    reasons.push({ code: "SECTION_INCOMPLETE", detail: { reason: "no committed sections at HEAD" } });
  }
  for (const section of facts.sections) {
    if (section.status !== "completed" || section.completedRevision !== section.revision) {
      reasons.push({
        code: section.status === "needs_review" ? "SECTION_NEEDS_REVIEW" : "SECTION_INCOMPLETE",
        detail: { sectionId: section.sectionId, status: section.status, completedRevision: section.completedRevision, headRevision: section.revision },
      });
    }
  }

  // §21 — no durable active Section may survive into finalization.
  if (facts.activeSection !== null) {
    reasons.push({ code: "ACTIVE_SECTION_PRESENT", detail: { sectionId: facts.activeSection } });
  }

  // §22/§23 — re-read from the authoritative current HEAD, typed fields only.
  if (facts.blockingQuestionCount > 0) {
    reasons.push({ code: "BLOCKING_QUESTION", detail: { count: facts.blockingQuestionCount } });
  }
  if (facts.blockingConflictCount > 0) {
    reasons.push({ code: "BLOCKING_CONFLICT", detail: { count: facts.blockingConflictCount } });
  }

  // §7/§9 — the exact Evidence closure still equals the frozen scope, and the
  // freshness policy holds: critical must be fresh (gate-time validated),
  // supporting may not sit needs_validation/stale/invalidated, informational
  // is recorded but never blocks. A reobserve revision needing re-observation
  // can never pass — commands are never replayed (§10).
  if (!facts.evidenceScopeMatches) {
    reasons.push({ code: "EVIDENCE_AUDIT_FAILED", detail: { reason: "current committed-design evidence reachability no longer equals the frozen input scope" } });
  }
  for (const entry of facts.evidence) {
    if (entry.criticality === "informational") continue;
    if (entry.requiresReobservation) {
      reasons.push({
        code: entry.criticality === "critical" ? "EVIDENCE_CRITICAL_NOT_FRESH" : "EVIDENCE_SUPPORTING_NEEDS_VALIDATION",
        detail: { evidenceId: entry.evidenceId, revision: entry.revision, reason: "reobserve strategy requires a new observation; automatic replay is forbidden" },
      });
      continue;
    }
    if (entry.criticality === "critical" && entry.state !== "fresh") {
      reasons.push({
        code: "EVIDENCE_CRITICAL_NOT_FRESH",
        detail: { evidenceId: entry.evidenceId, revision: entry.revision, state: entry.state },
      });
    }
    if (entry.criticality === "supporting" && entry.state !== "fresh") {
      reasons.push({
        code: "EVIDENCE_SUPPORTING_NEEDS_VALIDATION",
        detail: { evidenceId: entry.evidenceId, revision: entry.revision, state: entry.state },
      });
    }
  }

  // §14 — an ordinary awaiting Proposal must be resolved (approved or
  // superseded) before the world can freeze.
  if (facts.awaitingProposal !== null) {
    reasons.push({ code: "AWAITING_PROPOSAL_EXISTS", detail: { ...facts.awaitingProposal } });
  }

  return reasons.length === 0 ? { status: "pass" } : deny();
}

// ---------------------------------------------------------------------------
// §6/§8 — EvidenceAuditSnapshot
// ---------------------------------------------------------------------------

/** Disposition of one audited exact Evidence revision (§8/§9). */
export type EvidenceAuditDisposition = "pass" | "blocked" | "recorded";

export interface EvidenceAuditEntry {
  evidenceId: string;
  revision: number;
  confidence: string;
  criticality: "critical" | "supporting" | "informational";
  validationStrategy: string;
  /** Current state at audit time (after deterministic revalidation). */
  state: string;
  disposition: EvidenceAuditDisposition;
  reasonCode: string;
  /** Provenance aid only — never design semantics (§8). */
  lastValidationEventSeq: number | null;
}

/**
 * EvidenceAuditSnapshotV1 (§6): immutable, exact-revision scoped,
 * deterministically ordered, server-generated. The hash covers the semantic
 * payload; the audit id and timestamps are excluded.
 */
export interface EvidenceAuditSnapshotV1 {
  version: typeof FINALIZATION_AUDIT_VERSION;
  runId: string;
  inputId: string;
  inputHash: string;
  entries: EvidenceAuditEntry[];
}

export function evidenceAuditHash(audit: EvidenceAuditSnapshotV1): string {
  const canonical = {
    ...audit,
    entries: [...audit.entries].sort(
      (a, b) =>
        a.evidenceId.localeCompare(b.evidenceId) ||
        a.revision - b.revision,
    ),
  };
  return `sha256:${createHash("sha256").update(canonicalJson(canonical), "utf8").digest("hex")}`;
}

// ---------------------------------------------------------------------------
// §30/§31/§32 — FinalPlanCandidateV1
// ---------------------------------------------------------------------------

export interface CandidateArchitectureRef {
  id: string;
  revision: number;
}

export interface CandidateSectionRef {
  sectionId: string;
  revision: number;
}

export interface CandidateItemRef {
  kind: "decision" | "constraint";
  id: string;
  revision: number;
}

export interface CandidateEvidenceRef {
  evidenceId: string;
  revision: number;
}

/**
 * FinalPlanCandidateV1 (§31) — every field server-derived from the frozen
 * synthesis world; the model supplies none of them.
 */
export interface FinalPlanCandidateV1 {
  version: typeof FINAL_PLAN_CANDIDATE_VERSION;
  runId: string;
  baseRunRevision: number;
  baseHeadSnapshot: string;
  baseHeadCommit: string | null;
  synthesisInput: { inputId: string; inputHash: string };
  synthesisManifest: { manifestId: string; manifestHash: string };
  semanticValidation: { reportId: string; reportHash: string };
  architecture: CandidateArchitectureRef | null;
  sections: CandidateSectionRef[];
  decisions: CandidateItemRef[];
  constraints: CandidateItemRef[];
  /** Copied EXACTLY (authored order) from the manifest (§96). */
  implementationOrder: ImplementationStep[];
  limitations: DerivedStatement[];
  /** The exact frozen Evidence scope (§33) — not transient freshness state. */
  evidenceScope: CandidateEvidenceRef[];
}

/**
 * Canonical candidate hash (§32): sha256 over the canonical payload. The
 * candidate id, created_at, and audit event seqs are not part of the payload,
 * so a semantically equal re-derivation hashes identically. Collections are
 * canonically sorted except implementationOrder, whose authored order is
 * semantic and must be copied exactly from the manifest.
 */
export function finalPlanCandidateHash(candidate: FinalPlanCandidateV1): string {
  const canonical = {
    ...candidate,
    sections: [...candidate.sections].sort(
      (a, b) => a.sectionId.localeCompare(b.sectionId) || a.revision - b.revision,
    ),
    decisions: [...candidate.decisions].sort(
      (a, b) => a.id.localeCompare(b.id) || a.revision - b.revision,
    ),
    constraints: [...candidate.constraints].sort(
      (a, b) => a.id.localeCompare(b.id) || a.revision - b.revision,
    ),
    evidenceScope: [...candidate.evidenceScope].sort(
      (a, b) => a.evidenceId.localeCompare(b.evidenceId) || a.revision - b.revision,
    ),
  };
  return `sha256:${createHash("sha256").update(canonicalJson(canonical), "utf8").digest("hex")}`;
}

// ---------------------------------------------------------------------------
// §52/§54/§57 — FinalPlanV1
// ---------------------------------------------------------------------------

/**
 * FinalPlanV1 (§54) — the immutable approved planning artifact. Its hash
 * (§57) is the binding Phase 14's ExecutionHandoff must carry; nobody
 * re-summarizes the final plan downstream.
 */
export interface FinalPlanV1 {
  version: typeof FINAL_PLAN_VERSION;
  candidateHash: string;
  architecture: CandidateArchitectureRef | null;
  sections: CandidateSectionRef[];
  decisions: CandidateItemRef[];
  constraints: CandidateItemRef[];
  synthesisManifest: { manifestId: string; manifestHash: string };
  implementationOrder: ImplementationStep[];
  limitations: DerivedStatement[];
  validation: {
    blockingQuestions: 0;
    blockingConflicts: 0;
    invalidSections: 0;
    semanticValidation: "clean";
  };
  evidenceAudit: { auditId: string; auditHash: string };
}

export function finalPlanHash(plan: FinalPlanV1): string {
  const canonical = {
    ...plan,
    sections: [...plan.sections].sort(
      (a, b) => a.sectionId.localeCompare(b.sectionId) || a.revision - b.revision,
    ),
    decisions: [...plan.decisions].sort(
      (a, b) => a.id.localeCompare(b.id) || a.revision - b.revision,
    ),
    constraints: [...plan.constraints].sort(
      (a, b) => a.id.localeCompare(b.id) || a.revision - b.revision,
    ),
  };
  return `sha256:${createHash("sha256").update(canonicalJson(canonical), "utf8").digest("hex")}`;
}

// ---------------------------------------------------------------------------
// §44 — deterministic human-readable projection (PROJECTION ONLY)
// ---------------------------------------------------------------------------

/**
 * Render a FinalPlanCandidate as review Markdown. This is a PROJECTION: it is
 * never persisted as canonical truth, never hashed as authority, and never
 * parsed back into Plan Memory (§44/§80) — the structured candidate is
 * rebuildable at any time.
 */
export function renderFinalPlanCandidateMarkdown(
  candidate: FinalPlanCandidateV1,
  meta: { candidateId: string; candidateHash: string; proposalId: string; proposalRevision: number; proposalHash: string },
): string {
  const lines: string[] = [];
  lines.push("# Final Plan Candidate");
  lines.push("");
  lines.push(`- Candidate: ${meta.candidateId} (seq-bound, immutable)`);
  lines.push(`- Candidate hash: ${meta.candidateHash}`);
  lines.push(`- Final Proposal: ${meta.proposalId}@${meta.proposalRevision} (${meta.proposalHash})`);
  lines.push(`- Base HEAD: ${candidate.baseHeadSnapshot}${candidate.baseHeadCommit === null ? "" : ` / ${candidate.baseHeadCommit}`}`);
  lines.push(`- Synthesis input: ${candidate.synthesisInput.inputId} (${candidate.synthesisInput.inputHash})`);
  lines.push(`- Synthesis manifest: ${candidate.synthesisManifest.manifestId} (${candidate.synthesisManifest.manifestHash})`);
  lines.push(`- Semantic validation: ${candidate.semanticValidation.reportId} (${candidate.semanticValidation.reportHash}) — clean`);
  if (candidate.architecture !== null) {
    lines.push(`- Architecture: ${candidate.architecture.id}@${candidate.architecture.revision}`);
  }
  lines.push("");
  lines.push("## Sections");
  for (const section of [...candidate.sections].sort((a, b) => a.sectionId.localeCompare(b.sectionId))) {
    lines.push(`- ${section.sectionId}@${section.revision}`);
  }
  if (candidate.constraints.length > 0) {
    lines.push("");
    lines.push("## Hard constraints");
    for (const constraint of [...candidate.constraints].sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`- ${constraint.id}@${constraint.revision}`);
    }
  }
  if (candidate.decisions.length > 0) {
    lines.push("");
    lines.push("## Decisions");
    for (const decision of [...candidate.decisions].sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`- ${decision.id}@${decision.revision}`);
    }
  }
  lines.push("");
  lines.push("## Implementation order");
  for (const step of candidate.implementationOrder) {
    const deps = step.dependsOn.length > 0 ? ` (after ${step.dependsOn.join(", ")})` : "";
    lines.push(`- ${step.stepId}: ${step.title} — ${step.description}${deps}`);
  }
  if (candidate.limitations.length > 0) {
    lines.push("");
    lines.push("## Known limitations");
    for (const limitation of candidate.limitations) {
      lines.push(`- ${limitation.statement}`);
    }
  }
  lines.push("");
  lines.push(`Evidence scope: ${candidate.evidenceScope.length} exact revision(s), frozen by the synthesis input.`);
  lines.push("");
  lines.push("Markdown is a projection only — the canonical authority is the candidate/proposal hash above.");
  return lines.join("\n");
}
