/**
 * FinalPlanCandidate → FinalPlan projection (Phase 2I brief §11-§15).
 *
 * ONE MAPPING (brief §33): the FinalPlan is the deterministic projection of its
 * FinalPlanCandidate — built by `buildFinalPlanFromCandidate` at Proposal
 * freeze AND re-built by the transaction engine at commit validation, so a
 * hostile direct Final Proposal can never slip a tampered payload (changed
 * implementation order, dropped limitation, swapped Section revision, …) past
 * the exact candidate ref it claims to bind. No model call anywhere.
 *
 * EXACTNESS (brief §12/§13): exact approved refs only (ARCH@n, SEC-###@n,
 * DEC-###@n, committed constraints) plus the full derived-artifact provenance
 * chain (candidate/input/manifest/report/audit hashes + the pre-commit HEAD
 * snapshot) so it is provable what exact planning state the user approved.
 *
 * BODY (brief §14): `body` is the deterministic Markdown projection of the
 * structured payload — never an independently editable second source of truth.
 * Decision: the body IS persisted but hash-bound (the canonical hash covers it)
 * and re-verified against a fresh render on durable load — corruption of the
 * projection fails closed.
 *
 * approvedAt (brief §15/§40) is deliberately NOT part of the frozen content:
 * the Proposal freezes every SEMANTIC FinalPlan field, and approvedAt is
 * system transaction metadata = the exact user Approval's createdAt, stamped
 * by the engine at commit. It is never model-authored and never Date.now()
 * guesswork.
 */
import { createHash } from "node:crypto";

import { stableStringify } from "../core/invariants.js";
import type { FinalPlan } from "../core/types.js";
import type { FinalPlanID } from "../core/ids.js";
import type { FinalPlanCandidate, FinalizationIdentity } from "./types.js";

/**
 * The frozen semantic FinalPlan payload — everything the user approves, minus
 * the commit-time stamps (`status`, `approvedAt`) and the canonical `hash`.
 */
export type FinalPlanContent = Omit<FinalPlan, "status" | "approvedAt" | "hash">;

export interface BuildFinalPlanDeps {
  candidate: FinalPlanCandidate;
  /** Harness-assigned resulting FinalPlan identity (brief §9) — never model-supplied. */
  assign: { id: FinalPlanID; revision: number };
}

/**
 * The ONE candidate → FinalPlan projection (brief §33). Pure; shared by the
 * Proposal freeze and the transaction engine's commit validation. Every
 * authority-bearing field is an EXACT copy of the candidate's.
 */
export function buildFinalPlanFromCandidate(deps: BuildFinalPlanDeps): FinalPlanContent {
  const { candidate, assign } = deps;
  const content: FinalPlanContent = {
    id: assign.id,
    revision: assign.revision,
    planID: candidate.planID,
    architecture: { ...candidate.architecture },
    sections: candidate.sections.map((section) => ({ ...section })),
    decisions: candidate.decisions.map((decision) => ({ ...decision })),
    constraints: candidate.constraints.map((constraint) => ({ ...constraint })),
    implementationOrder: candidate.implementationOrder.map((step) => ({ ...step })),
    limitations: candidate.limitations.map((limitation) => ({ ...limitation })),
    finalPlanCandidate: {
      id: candidate.id,
      revision: candidate.revision,
      hash: candidate.hash,
    },
    synthesisInput: { ...candidate.synthesisInput },
    synthesisManifest: { ...candidate.synthesisManifest },
    semanticValidation: {
      reportID: candidate.semanticValidation.reportID,
      hash: candidate.semanticValidation.hash,
      result: "clean",
    },
    evidenceAudit: {
      id: candidate.evidenceAudit.id,
      hash: candidate.evidenceAudit.hash,
      result: "pass",
    },
    baseSnapshot: { ...candidate.baseSnapshot },
    baseCommit: candidate.baseCommit,
    body: renderFinalPlanBody({
      id: assign.id,
      revision: assign.revision,
      planID: candidate.planID,
      architecture: candidate.architecture,
      sections: candidate.sections,
      decisions: candidate.decisions,
      constraints: candidate.constraints,
      implementationOrder: candidate.implementationOrder,
      limitations: candidate.limitations,
      finalPlanCandidate: { id: candidate.id, revision: candidate.revision, hash: candidate.hash },
      synthesisInput: candidate.synthesisInput,
      synthesisManifest: candidate.synthesisManifest,
      semanticValidation: {
        reportID: candidate.semanticValidation.reportID,
        hash: candidate.semanticValidation.hash,
        result: "clean",
      },
      evidenceAudit: { id: candidate.evidenceAudit.id, hash: candidate.evidenceAudit.hash, result: "pass" },
      baseSnapshot: candidate.baseSnapshot,
      baseCommit: candidate.baseCommit,
    }),
  };
  return content;
}

/** Canonical FinalPlan content hash — SHA-256 over the stable serialization minus `hash`. */
export function computeFinalPlanHashFromContent(record: Omit<FinalPlan, "hash">): string {
  // Defensive exclusion: callers may pass a full record (extra properties are
  // fine); the hash never covers itself.
  const { hash: _hash, ...rest } = record as FinalPlan;
  void _hash;
  const digest = createHash("sha256");
  digest.update(stableStringify(rest));
  return digest.digest("hex");
}

/**
 * Deterministic Markdown projection of the structured FinalPlan (brief §14) —
 * the ONE renderer; the stored `body` must equal a fresh render of the payload
 * (verified at commit and on durable load).
 */
export function renderFinalPlanBody(plan: Omit<FinalPlanContent, "body">): string {
  const lines: string[] = [
    `# Final Plan ${plan.id}@${plan.revision}`,
    "",
    `Plan: ${plan.planID}`,
    `Base snapshot: ${plan.baseSnapshot.id}`,
    `Base commit: ${plan.baseCommit ?? "none"}`,
    "",
    `## Architecture`,
    `ARCH@${plan.architecture.revision}`,
    "",
    "## Sections",
    ...(plan.sections.length > 0 ? plan.sections.map((section) => `- ${section.id}@${section.revision}`) : ["- (none)"]),
    "",
    "## Implementation order",
    ...(plan.implementationOrder.length > 0
      ? plan.implementationOrder.map((step) => `${step.order}. ${step.title} — ${step.description}`)
      : ["(none)"]),
    "",
    "## Decisions",
    ...(plan.decisions.length > 0 ? plan.decisions.map((decision) => `- ${decision.id}@${decision.revision}`) : ["- (none)"]),
    "",
    "## Constraints",
    ...(plan.constraints.length > 0
      ? plan.constraints.map((constraint) => `- [${constraint.severity}] ${constraint.statement}`)
      : ["- (none)"]),
    "",
    "## Known limitations",
    ...(plan.limitations.length > 0 ? plan.limitations.map((limitation) => `- ${limitation.statement}`) : ["- (none)"]),
    "",
    "## Provenance",
    `- Semantic validation: ${plan.semanticValidation.reportID} clean (hash ${plan.semanticValidation.hash})`,
    `- Evidence audit: ${plan.evidenceAudit.id} pass (hash ${plan.evidenceAudit.hash})`,
    `- Synthesis manifest: ${plan.synthesisManifest.id}@${plan.synthesisManifest.revision} (hash ${plan.synthesisManifest.hash})`,
    `- Synthesis input: ${plan.synthesisInput.id} (hash ${plan.synthesisInput.hash})`,
    `- Final plan candidate: ${plan.finalPlanCandidate.id}@${plan.finalPlanCandidate.revision} (hash ${plan.finalPlanCandidate.hash})`,
  ];
  return lines.join("\n");
}

/**
 * §27 exact-identity check: the CURRENT passing gate identity must still be
 * the identity the candidate (and therefore the Proposal binding it) was
 * frozen against — HEAD, input, manifest (id + revision + hash), report, and
 * audit. A current gate that would pass with a DIFFERENT identity makes the
 * old Final Proposal stale; it can never commit.
 */
export function finalizationIdentityMatchesCandidate(
  identity: FinalizationIdentity,
  candidate: FinalPlanCandidate,
): boolean {
  return (
    identity.headSnapshot.id === candidate.baseSnapshot.id &&
    identity.headCommit === candidate.baseCommit &&
    identity.architecture.revision === candidate.architecture.revision &&
    identity.synthesisInput.id === candidate.synthesisInput.id &&
    identity.synthesisInput.hash === candidate.synthesisInput.hash &&
    identity.synthesisManifest.id === candidate.synthesisManifest.id &&
    identity.synthesisManifest.revision === candidate.synthesisManifest.revision &&
    identity.synthesisManifest.hash === candidate.synthesisManifest.hash &&
    identity.validationReport.id === candidate.semanticValidation.reportID &&
    identity.validationReport.hash === candidate.semanticValidation.hash &&
    identity.evidenceAudit.id === candidate.evidenceAudit.id &&
    identity.evidenceAudit.hash === candidate.evidenceAudit.hash
  );
}
