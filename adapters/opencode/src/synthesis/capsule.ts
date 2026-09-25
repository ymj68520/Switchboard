/**
 * Deterministic synthesis capsule (Phase 2F brief §21) — the begin-synthesis
 * response body. Rendered from structured frozen state only: never model-
 * generated, never another inference pass, byte-stable for identical state.
 * Timestamps and hashes-adjacent metadata stay out; Section designs render
 * through their stable compact/contract projections read from the exact
 * immutable revisions (brief §10/§11) — full revisions remain available via
 * plan_memory.
 */
import type { PlanStore } from "../memory/store.js";
import type { SynthesisInput } from "./types.js";

export async function renderSynthesisCapsule(store: PlanStore, input: SynthesisInput): Promise<string> {
  const architecture = await store.getArchitecture(input.planID, input.architecture.revision);
  const lines: string[] = [
    "=== SYNTHESIS INPUT (frozen) ===",
    `Synthesis Input: ${input.id}`,
    `Base: ${input.baseSnapshot.id}`,
    `Base commit: ${input.baseCommit ?? "none"}`,
    `Hash: ${input.hash}`,
    "",
    `Architecture: ARCH@${input.architecture.revision} approved`,
  ];
  if (architecture) {
    // Deterministic projection from the approved structured content — no
    // inference (brief §11).
    lines.push(`  Summary: ${architecture.summary}`);
    for (const component of architecture.components) lines.push(`  Component: ${component.name} — ${component.summary}`);
    for (const boundary of architecture.boundaries) lines.push(`  Boundary: ${boundary.name} — ${boundary.description}`);
    for (const flow of architecture.dataFlows) lines.push(`  Data flow: ${flow.from} -> ${flow.to} — ${flow.description}`);
    for (const principle of architecture.principles) lines.push(`  Principle: ${principle.statement}`);
  }

  lines.push("", "Sections:");
  for (const section of input.sections) {
    const revision = await store.getSectionRevision(input.planID, section.ref);
    lines.push(`${section.ref.id}@${section.ref.revision} — ${section.title}`);
    lines.push(`  Dependencies: ${section.dependencies.length > 0 ? section.dependencies.join(", ") : "none"}`);
    if (revision) {
      lines.push(`  Compact: ${revision.projection.compact}`);
      const contract = revision.projection.contract;
      lines.push(`  Contract provides: ${contract.provides.length > 0 ? contract.provides.join(", ") : "none"}`);
      lines.push(`  Contract requires: ${contract.requires.length > 0 ? contract.requires.join(", ") : "none"}`);
      lines.push(`  Contract interfaces: ${contract.interfaces.length > 0 ? contract.interfaces.map((i) => i.name).join(", ") : "none"}`);
    }
  }

  lines.push("", "Decisions:");
  if (input.decisions.length === 0) lines.push("  (none)");
  for (const decision of input.decisions) lines.push(`  ${decision.id}@${decision.revision}`);

  lines.push("", "Constraints:");
  if (input.constraints.length === 0) lines.push("  (none)");
  for (const constraint of input.constraints) {
    lines.push(`  ${constraint.id} [${constraint.severity}] ${constraint.statement}`);
  }

  lines.push("", "Questions (frozen blocker state):");
  if (input.questions.length === 0) lines.push("  (none)");
  for (const question of input.questions) {
    lines.push(`  ${question.id} [${question.blocking ? "blocking" : "non-blocking"}] ${question.question}`);
  }

  lines.push("", "Conflicts (frozen blocker state):");
  if (input.conflicts.length === 0) lines.push("  (none)");
  for (const conflict of input.conflicts) {
    lines.push(`  ${conflict.id} [${conflict.severity}/${conflict.type}] ${conflict.description}`);
  }

  lines.push("", "Relevant Evidence (SectionRevision → Decision → Evidence):");
  if (input.evidence.length === 0) lines.push("  (none)");
  for (const evidence of input.evidence) {
    lines.push(`  ${evidence.id}@${evidence.revision} [${evidence.confidence}/${evidence.criticality}/${evidence.freshness}/${evidence.status}]`);
  }

  lines.push("", "Derived artifacts are created with ultraplan_submit_synthesis_manifest.", "=== END SYNTHESIS INPUT ===");
  return lines.join("\n");
}
