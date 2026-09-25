/**
 * Deterministic ValidationCapsule (Phase 2G brief §14/§15).
 *
 * Derived ONLY from exact frozen authority: the SynthesisInput (including full
 * approved SectionRevision bodies — semantic validation may need more than
 * compact projections, §15) and the exact SynthesisManifest revision. No raw
 * planning conversation, no live state beyond resolving the exact revisions
 * the input binds, no model generation. Byte-stable for identical frozen state.
 */
import type { PlanStore } from "../memory/store.js";
import type { SynthesisInput, SynthesisManifest, SynthesisSourceRef } from "../synthesis/types.js";

function list(prefix: string, items: readonly string[]): string {
  return items.length === 0 ? `${prefix}: —` : `${prefix}: ${items.join("; ")}`;
}

/**
 * Build the capsule for one exact (input, manifest) pair. Assumes the caller
 * has already resolved the pair against CURRENT run state (brief §11/§12).
 */
export async function buildValidationCapsule(
  store: PlanStore,
  input: SynthesisInput,
  manifest: SynthesisManifest,
): Promise<string> {
  const lines: string[] = [
    "=== SEMANTIC VALIDATION CAPSULE ===",
    `Validator protocol: semantic-validation:v1`,
    `SynthesisInput: ${input.id} (hash ${input.hash}) base ${input.baseSnapshot.id}`,
    `SynthesisManifest under validation: ${manifest.id}@${manifest.revision} (hash ${manifest.hash}, input ${manifest.input.id})`,
    "",
    `ARCHITECTURE ${input.architecture.id}@${input.architecture.revision} (approved)`,
  ];

  const architecture = await store.getArchitecture(input.planID, input.architecture.revision);
  if (architecture) {
    lines.push(`  Summary: ${architecture.summary}`);
    if (architecture.components.length > 0) {
      lines.push(`  Components: ${architecture.components.map((c) => `${c.name} — ${c.summary}`).join("; ")}`);
    }
    if (architecture.boundaries.length > 0) {
      lines.push(`  Boundaries: ${architecture.boundaries.map((b) => `${b.name} — ${b.description}`).join("; ")}`);
    }
    if (architecture.dataFlows.length > 0) {
      lines.push(`  Data flows: ${architecture.dataFlows.map((f) => `${f.from} -> ${f.to} (${f.description})`).join("; ")}`);
    }
    if (architecture.principles.length > 0) {
      lines.push(`  Principles: ${architecture.principles.map((p) => p.statement).join("; ")}`);
    }
    if (architecture.basedOn.length > 0) {
      lines.push(`  Based on decisions: ${architecture.basedOn.join(", ")}`);
    }
    if (architecture.unresolved.length > 0) {
      lines.push(
        `  Unresolved questions: ${architecture.unresolved.map((q) => `${q.id}${q.blocking ? " (blocking)" : ""}`).join(", ")}`,
      );
    }
  }

  // Exact approved SectionRevision content — FULL bodies, not just compact
  // projections (§15: the validator may need more than projections to judge
  // support). Still deterministic: exact frozen revisions only.
  lines.push("", "SECTIONS (exact approved revisions):");
  for (const section of input.sections) {
    lines.push(
      `${section.ref.id}@${section.ref.revision} — ${section.title} (depends on: ${section.dependencies.join(", ") || "—"})`,
    );
    const revision = await store.getSectionRevision(input.planID, section.ref);
    if (!revision) continue; // fail-closed resolution happens upstream (§12); capsule renders what exists
    lines.push(`  problem: ${revision.problem}`);
    lines.push(`  design: ${revision.design}`);
    if (revision.interfaces.length > 0) {
      lines.push(
        `  interfaces: ${revision.interfaces.map((spec) => `${spec.name}${spec.signature ? `(${spec.signature})` : ""}: ${spec.description}`).join("; ")}`,
      );
    }
    if (revision.invariants.length > 0) lines.push(`  invariants: ${revision.invariants.join("; ")}`);
    if (revision.failureModes.length > 0) {
      lines.push(
        `  failure modes: ${revision.failureModes.map((mode) => `${mode.description}${mode.mitigation ? ` (mitigation: ${mode.mitigation})` : ""}`).join("; ")}`,
      );
    }
    if (revision.dependencies.length > 0) {
      lines.push(
        `  dependency bindings: ${revision.dependencies
          .map((dep) => (dep.contractRevision !== undefined ? `${dep.sectionID}@${dep.contractRevision}` : dep.sectionID))
          .join(", ")}`,
      );
    }
    lines.push(`  compact projection: ${revision.projection.compact}`);
    const contract = revision.projection.contract;
    lines.push(
      `  contract: provides ${contract.provides.join(", ") || "—"}; requires ${contract.requires.join(", ") || "—"}; invariants ${contract.invariants.join("; ") || "—"}; interfaces ${contract.interfaces.map((ref) => ref.name).join(", ") || "—"}; decisions ${contract.decisions.map((ref) => `${ref.id}@${ref.revision}`).join(", ") || "—"}`,
    );
  }

  lines.push("", "DECISIONS (exact approved revisions):");
  if (input.decisions.length === 0) lines.push("  —");
  for (const ref of input.decisions) {
    const decision = await store.getDecision(input.planID, ref);
    lines.push(
      decision
        ? `${decision.id}@${decision.revision} — ${decision.title}: ${decision.statement}`
        : `${ref.id}@${ref.revision} — (unresolvable; the input is inconsistent)`,
    );
  }

  lines.push("", "CONSTRAINTS (committed):");
  if (input.constraints.length === 0) lines.push("  —");
  for (const constraint of input.constraints) {
    lines.push(`${constraint.id} (${constraint.severity}, source ${constraint.source}): ${constraint.statement}`);
  }

  lines.push("", "FROZEN QUESTION STATE:");
  if (input.questions.length === 0) lines.push("  —");
  for (const question of input.questions) {
    lines.push(`${question.id} [${question.blocking ? "blocking" : "non-blocking"}/${question.status}] ${question.question}`);
  }

  lines.push("", "FROZEN CONFLICT STATE:");
  if (input.conflicts.length === 0) lines.push("  —");
  for (const conflict of input.conflicts) {
    lines.push(`${conflict.id} [${conflict.severity}/${conflict.status}] ${conflict.type}: ${conflict.description}`);
  }

  lines.push("", "FROZEN EVIDENCE STATE:");
  if (input.evidence.length === 0) lines.push("  —");
  for (const evidence of input.evidence) {
    lines.push(`${evidence.id}@${evidence.revision} [${evidence.confidence}/${evidence.criticality}/${evidence.freshness}/${evidence.status}]`);
  }

  lines.push(
    "",
    `MANIFEST ${manifest.id}@${manifest.revision} DERIVED CONTENT:`,
    list("Cross-section links", manifest.crossSectionLinks.map((link, index) => `[${index + 1}] ${link.statement} (sources: ${link.sources.map((source) => sourceRefLabel(source)).join(", ")})`)),
    "",
    "Implementation order:",
  );
  if (manifest.implementationOrder.length === 0) lines.push("  —");
  for (const step of manifest.implementationOrder) {
    lines.push(`  ${step.order}. ${step.title} — ${step.description}`);
    lines.push(`     sections: ${step.sections.map((ref) => `${ref.id}@${ref.revision}`).join(", ")}`);
    lines.push(`     sources: ${step.sources.map((source) => sourceRefLabel(source)).join(", ")}`);
  }
  lines.push("");
  lines.push(list("Limitations", manifest.limitations.map((limitation, index) => `[${index + 1}] ${limitation.statement} (sources: ${limitation.sources.map((source) => sourceRefLabel(source)).join(", ")})`)));
  lines.push(
    list(
      "Unresolved findings (synthesis-declared)",
      manifest.unresolvedFindings.map(
        (finding, index) => `[${index + 1}] (${finding.category}) ${finding.statement}${finding.sources ? ` (sources: ${finding.sources.map((source) => sourceRefLabel(source)).join(", ")})` : ""}`,
      ),
    ),
  );
  lines.push("=== END CAPSULE ===");
  return lines.join("\n");
}

function sourceRefLabel(ref: SynthesisSourceRef): string {
  switch (ref.kind) {
    case "architecture":
      return "architecture";
    case "section":
    case "decision":
    case "evidence":
      return `${ref.kind} ${ref.id}@${ref.revision}`;
    default:
      return `${ref.kind} ${ref.id}`;
  }
}
