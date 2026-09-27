/**
 * ExecutionHandoff canonical model (Phase 14 §22–§31/§60/§107).
 *
 * PURE core: vocabulary, canonical shape, deterministic hashing, and the
 * deterministic human-readable Execution Contract projection. No SQLite, no
 * host, no git, no MCP.
 *
 * Authority model (§1): Final Approval + Final PlanCommit authorize the
 * transition; the ExecutionHandoff is a DETERMINISTIC PROJECTION of the
 * approved FinalPlan — it re-runs no design choice, re-synthesizes nothing,
 * and contains no model-authored design facts (§22/§47/§48). The handoff hash
 * covers content only (§31): the handoff id, timestamps, delivery state,
 * session id, and binding generation are excluded, so a semantically equal
 * re-derivation from the same immutable FinalPlan hashes identically.
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";
import type { DerivedStatement, ImplementationStep } from "./synthesis.js";

export const EXECUTION_HANDOFF_VERSION = 1 as const;

/** §24 — the workspace baseline frozen at handoff creation (§25). */
export type RepositoryBaseline =
  | { kind: "git"; revision: string }
  | { kind: "directory"; revision: null };

export interface HandoffArchitectureRef {
  id: string;
  revision: number;
}

export interface HandoffSectionContractRef {
  sectionId: string;
  revision: number;
}

export interface HandoffItemRef {
  id: string;
  revision: number;
}

/**
 * ExecutionHandoffV1 (§23) — every field server-derived from the approved
 * FinalPlan and authoritative structured planning state. Policy provenance:
 *   hardConstraints      exact FinalPlan constraint refs with severity=hard (§26)
 *   requiredContracts    ALL current FinalPlan Sections' contract refs (§27)
 *   criticalDecisions    ALL exact FinalPlan decision refs — conservative
 *                        mapping because no formal decision criticality
 *                        classifier exists in v0.1 (§28)
 *   knownLimitations     the FinalPlan's approved limitations verbatim (§29)
 *   validationRequirements   empty: no canonical source exists today (§30)
 */
export interface ExecutionHandoffV1 {
  version: typeof EXECUTION_HANDOFF_VERSION;
  finalPlan: { id: string; revision: number; hash: string };
  repositoryBaseline: RepositoryBaseline;
  goal: string;
  hardConstraints: HandoffItemRef[];
  architectureRef: HandoffArchitectureRef;
  implementationSteps: ImplementationStep[];
  requiredContracts: HandoffSectionContractRef[];
  criticalDecisions: HandoffItemRef[];
  knownLimitations: DerivedStatement[];
  validationRequirements: never[];
}

/**
 * Canonical handoff hash (§31): sha256 over the canonical content payload.
 * The handoff id, created_at, delivery state, session id, and binding
 * generation are not part of the payload — Build edits after delivery never
 * change the baseline or the hash (§25).
 */
export function executionHandoffHash(handoff: ExecutionHandoffV1): string {
  const canonical = {
    ...handoff,
    hardConstraints: [...handoff.hardConstraints].sort(
      (a, b) => a.id.localeCompare(b.id) || a.revision - b.revision,
    ),
    requiredContracts: [...handoff.requiredContracts].sort(
      (a, b) => a.sectionId.localeCompare(b.sectionId) || a.revision - b.revision,
    ),
    criticalDecisions: [...handoff.criticalDecisions].sort(
      (a, b) => a.id.localeCompare(b.id) || a.revision - b.revision,
    ),
  };
  return `sha256:${createHash("sha256").update(canonicalJson(canonical), "utf8").digest("hex")}`;
}

// ---------------------------------------------------------------------------
// §60/§77/§107 — deterministic Execution Contract renderer (PROJECTION ONLY)
// ---------------------------------------------------------------------------

/**
 * Render the deterministic Execution Contract. Like every Markdown projection
 * it is never persisted as canonical truth and never parsed back — the
 * structured handoff is rebuildable from the Store at any time. The guidance
 * block (§107) is the approved execution boundary made explicit, not a new
 * design artifact.
 */
export function renderExecutionContract(
  handoff: ExecutionHandoffV1,
  meta: { handoffId: string; handoffHash: string },
): string {
  const lines: string[] = [];
  lines.push("[Phase Plan Execution Contract v1]");
  lines.push("");
  lines.push(`Final Plan: ${handoff.finalPlan.id} (${handoff.finalPlan.hash})`);
  lines.push(`Handoff: ${meta.handoffId} (${meta.handoffHash})`);
  lines.push(
    handoff.repositoryBaseline.kind === "git"
      ? `Repository baseline: git @ ${handoff.repositoryBaseline.revision}`
      : "Repository baseline: directory workspace (no revision)",
  );
  lines.push(`Goal: ${handoff.goal}`);
  lines.push(
    `Hard constraints: ${
      [...handoff.hardConstraints]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((ref) => `${ref.id}@${ref.revision}`)
        .join(", ") || "(none)"
    }`,
  );
  lines.push(`Architecture: ${handoff.architectureRef.id}@${handoff.architectureRef.revision}`);
  lines.push("Implementation order:");
  for (const step of handoff.implementationSteps) {
    const deps = step.dependsOn.length > 0 ? ` (after ${step.dependsOn.join(", ")})` : "";
    lines.push(`  - ${step.stepId}: ${step.title} — ${step.description}${deps}`);
  }
  lines.push(
    `Required contracts: ${
      [...handoff.requiredContracts]
        .sort((a, b) => a.sectionId.localeCompare(b.sectionId))
        .map((ref) => `${ref.sectionId}@${ref.revision}`)
        .join(", ") || "(none)"
    }`,
  );
  if (handoff.knownLimitations.length > 0) {
    lines.push("Known limitations:");
    for (const limitation of handoff.knownLimitations) {
      lines.push(`  - ${limitation.statement}`);
    }
  }
  lines.push("");
  lines.push("You may choose local implementation details that do not alter approved semantics.");
  lines.push("Replanning is required if execution would change:");
  for (const boundary of [
    "hard constraint",
    "invariant",
    "approved interface",
    "SectionContract",
    "Decision",
    "explicit dependency",
    "architecture choice",
    "critical repository assumption",
    "missing design obligation",
  ]) {
    lines.push(`- ${boundary}`);
  }
  lines.push("");
  lines.push("Plan Memory is read-only under the execution contract.");
  return lines.join("\n");
}
