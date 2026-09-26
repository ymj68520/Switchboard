/**
 * Recovery Capsule rendering primitives (Phase 8 directive §17).
 *
 * Rendering is deterministic: the same PhasePlanContext always renders to the
 * same text (E14). The capsule is segmented and machine-unambiguous, but it
 * is a PROJECTION — the structured context remains the internal authority
 * (§16). Rendering must never include secrets: no HostContext tokens, no
 * signing material, no database paths, no session ids of other sessions
 * (§45) — the input type only carries planning-domain state.
 */

import type { PhasePlanContext } from "./types.js";

export const RECOVERY_CAPSULE_HEADER = "[Phase Plan Recovery v3]";

/** One named capsule section with its budget priority. */
export interface CapsuleSegment {
  /** Stable segment name, reused verbatim in omission markers. */
  name: string;
  /** P0 segments are mandatory; dropping a P1 segment is explicit, never silent. */
  required: boolean;
  text: string;
}

function indent(lines: readonly string[]): string {
  return lines.map((line) => `  ${line}`).join("\n");
}

export function runSegment(context: PhasePlanContext): CapsuleSegment {
  return {
    name: "run",
    required: true,
    text: [
      "Run:",
      indent([
        `id=${context.run.runId}`,
        `lifecycle=${context.run.lifecycle}`,
        `stage=${context.run.stage}`,
        `revision=${context.run.revision}`,
        `goal=${context.run.goal}`,
      ]),
    ].join("\n"),
  };
}

export function headSegment(context: PhasePlanContext): CapsuleSegment {
  return {
    name: "head",
    required: true,
    text: [
      "HEAD:",
      indent([
        `commit=${context.head.commitId ?? "none"}`,
        `snapshot=${context.head.snapshotId ?? "none"}`,
        `context_epoch=${context.epoch}`,
      ]),
    ].join("\n"),
  };
}

export function hardConstraintsSegment(context: PhasePlanContext): CapsuleSegment {
  const entries = context.globalMemory.hardConstraints.map(
    (constraint) => `- ${constraint.ref.id}@${constraint.ref.revision} (${constraint.source}): ${constraint.statement}`,
  );
  return {
    name: "hard constraints",
    required: true,
    text: ["Hard constraints:", entries.length === 0 ? "  (none)" : indent(entries)].join("\n"),
  };
}

export function architectureSegment(context: PhasePlanContext): CapsuleSegment {
  const architecture = context.globalMemory.architecture;
  return {
    name: "approved architecture",
    required: false,
    text:
      architecture === null
        ? "Approved architecture: (none)"
        : [
            `Approved architecture: ${architecture.ref.id}@${architecture.ref.revision}`,
            indent(architecture.compactProjection.split("\n")),
          ].join("\n"),
  };
}

export function activeScopeSegment(context: PhasePlanContext): CapsuleSegment {
  // Phase 11: the durable active Section (§10/§11), resolved against the
  // current HEAD snapshot by the assembler.
  const active = context.activeScope;
  return {
    name: "active scope",
    required: true,
    text:
      active === null
        ? "Active scope: none"
        : `Active scope: section ${active.sectionId}@${active.revision} (${active.workflowStatus}) — ${active.title}`,
  };
}

/** §50 — compact workflow summary; never full Section designs. */
export function sectionWorkflowSegment(context: PhasePlanContext): CapsuleSegment {
  const entries = context.sectionWorkflow.sections.map((section) => {
    const completed =
      section.completedRevision !== undefined ? ` (completed @${section.completedRevision})` : "";
    return `- ${section.ref.id}@${section.ref.revision}: ${section.status}${completed} — ${section.title}`;
  });
  return {
    name: "section workflow",
    required: true,
    text: ["Section workflow:", entries.length === 0 ? "  (no sections)" : indent(entries)].join("\n"),
  };
}

/** §51 — the active Section's DIRECT dependency contracts, compact form. */
export function dependencyContractsSegment(context: PhasePlanContext): CapsuleSegment {
  if (context.activeScope === null) {
    return { name: "dependency contracts", required: false, text: "Dependency contracts: (no active section)" };
  }
  if (context.activeDependencyContracts.length === 0) {
    return { name: "dependency contracts", required: false, text: "Dependency contracts: (none)" };
  }
  const entries = context.activeDependencyContracts.map((entry) => {
    const c = entry.contract;
    return [
      `- ${entry.ref.id}@${entry.ref.revision} contract:`,
      indent([
        `provides=[${c.provides.join("; ")}]`,
        `requires=[${c.requires.join("; ")}]`,
        `invariants=[${c.invariants.join("; ")}]`,
        `interfaces=[${c.interfaces.join("; ")}]`,
      ]),
    ].join("\n");
  });
  return {
    name: "dependency contracts",
    required: true,
    text: ["Dependency contracts (direct dependencies of the active section):", ...entries].join("\n"),
  };
}

/** §31/§105 — the frozen synthesis identity; exact recovery facts, never prose. */
export function synthesisSegment(context: PhasePlanContext): CapsuleSegment {
  const synthesis = context.synthesis;
  if (synthesis === null) {
    return { name: "synthesis", required: false, text: "Synthesis: (no frozen input)" };
  }
  return {
    name: "synthesis",
    required: true,
    text: [
      "Synthesis:",
      indent([
        `input=${synthesis.inputId}`,
        `input_hash=${synthesis.inputHash}`,
        `base_head_snapshot=${synthesis.baseHead.snapshotId}`,
        `base_head_commit=${synthesis.baseHead.commitId ?? "none"}`,
        `refs=design:${synthesis.refCounts.design},evidence:${synthesis.refCounts.evidence}`,
      ]),
    ].join("\n"),
  };
}

/** §31/§105 — the accepted manifest, present at stage validation. */
export function synthesisManifestSegment(context: PhasePlanContext): CapsuleSegment {
  const manifest = context.synthesisManifest;
  if (manifest === null) {
    return { name: "synthesis manifest", required: false, text: "Synthesis manifest: (none)" };
  }
  return {
    name: "synthesis manifest",
    required: true,
    text: ["Synthesis manifest:", indent([`id=${manifest.manifestId}`, `hash=${manifest.manifestHash}`])].join("\n"),
  };
}

/** §71/§72 — the validation outcome: counts only; full detail via get_context(detail=validation). */
export function semanticValidationSegment(context: PhasePlanContext): CapsuleSegment {
  const validation = context.semanticValidation;
  if (validation === null) {
    return {
      name: "semantic validation",
      required: false,
      text: "Semantic validation: (no report yet)",
    };
  }
  if (validation.isClean) {
    return {
      name: "semantic validation",
      required: true,
      text: ["Semantic validation:", indent([`report=${validation.reportId}`, "clean=true", "Finalization not yet performed."])].join("\n"),
    };
  }
  const counts = validation.findingCounts.map((entry) => `${entry.kind}: ${entry.count}`);
  return {
    name: "semantic validation",
    required: true,
    text: [
      "Semantic validation:",
      indent([`report=${validation.reportId}`, "clean=false", "findings:", indent(counts)]),
    ].join("\n"),
  };
}

export function blockingSegment(context: PhasePlanContext): CapsuleSegment {
  const questions = context.globalMemory.blockingQuestions.map(
    (question) => `- ${question.ref.id}@${question.ref.revision}: ${question.question}`,
  );
  const conflicts = context.globalMemory.blockingConflicts.map(
    (conflict) => `- ${conflict.ref.id}@${conflict.ref.revision} (${conflict.type}): ${conflict.description}`,
  );
  const lines: string[] = [
    "Blocking:",
    questions.length === 0 ? "  questions=(none)" : ["  questions=", ...questions.map((q) => `    ${q}`)].join("\n"),
    conflicts.length === 0 ? "  conflicts=(none)" : ["  conflicts=", ...conflicts.map((c) => `    ${c}`)].join("\n"),
  ];
  return { name: "blocking conditions", required: true, text: lines.join("\n") };
}

export function awaitingProposalSegment(context: PhasePlanContext): CapsuleSegment {
  const proposal = context.working.awaitingProposal;
  if (proposal === null) {
    return { name: "awaiting proposal", required: true, text: "Awaiting proposal: (none)" };
  }
  return {
    name: "awaiting proposal",
    required: true,
    text: [
      "Awaiting proposal:",
      indent([
        `id=${proposal.proposalId}`,
        `revision=${proposal.revision}`,
        `hash=${proposal.hash}`,
        `type=${proposal.type}`,
        `scope=${
          proposal.scope.kind === "section"
            ? `section:${proposal.scope.sectionId}`
            : proposal.scope.kind
        }`,
        `title=${proposal.title}`,
        `summary=${proposal.summary}`,
      ]),
    ].join("\n"),
  };
}

export function sectionsSegment(context: PhasePlanContext): CapsuleSegment {
  const entries = context.globalMemory.sections.map(
    (section) => `- ${section.ref.id}@${section.ref.revision}: ${section.title}`,
  );
  return {
    name: "committed sections",
    required: false,
    text: ["Committed sections:", entries.length === 0 ? "  (none)" : indent(entries)].join("\n"),
  };
}

export function operationsSegment(context: PhasePlanContext): CapsuleSegment {
  return {
    name: "available operations",
    required: true,
    text: ["Available Phase Plan operations:", indent(context.operations.map((op) => `- ${op}`))].join("\n"),
  };
}

/** Join segments in display order — the only serialization path. */
export function renderRecoveryCapsule(segments: readonly CapsuleSegment[]): string {
  return [RECOVERY_CAPSULE_HEADER, ...segments.map((segment) => segment.text)].join("\n\n");
}
