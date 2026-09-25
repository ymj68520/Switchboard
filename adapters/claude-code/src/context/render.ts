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

export const RECOVERY_CAPSULE_HEADER = "[Phase Plan Recovery v1]";

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

export function activeScopeSegment(): CapsuleSegment {
  // The context's `activeScope` is typed null until the Section workflow
  // phase (§8); the line keeps the §17 capsule shape stable.
  return {
    name: "active scope",
    required: true,
    text: "Active scope: none",
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
        `scope=${proposal.scope.kind === "section" ? `section:${proposal.scope.sectionId}` : "architecture"}`,
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
