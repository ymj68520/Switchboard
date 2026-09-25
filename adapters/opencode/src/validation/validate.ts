/**
 * Structural validation of parsed validator output against the EXACT frozen
 * authority (Phase 2G brief §13/§23).
 *
 * The SEMANTIC judgment came from the validator; the Harness independently
 * verifies the report's STRUCTURE — every reference resolves exactly against
 * the current SynthesisInput/manifest, the cardinality rules hold, and a
 * manifest that declares unresolved findings can never be reported clean
 * (§13: "Even if the model outputs clean, the Harness must fail closed").
 *
 * This is report validation, not a second semantic opinion: the Harness does
 * not re-derive or second-guess findings, and it never converts a rejected
 * execution into findings (§26 — structural rejection is an execution failure,
 * no report is persisted, retry is allowed).
 */
import { UltraPlanError } from "../core/errors.js";
import type { SynthesisInput, SynthesisManifest } from "../synthesis/types.js";
import { sourceRefResolves } from "../synthesis/validate.js";
import type { ValidationReportDraft } from "./types.js";

export function invalidOutput(reason: string, detail?: Record<string, unknown>): UltraPlanError {
  return new UltraPlanError("validation_output_invalid", `Semantic validator output rejected: ${reason}`, detail);
}

/**
 * Validate the parsed draft against the exact input + manifest pair (§23):
 * throws `validation_output_invalid` on the first failure; the caller
 * persists NOTHING on throw.
 */
export function validateValidatorOutput(
  draft: ValidationReportDraft,
  input: SynthesisInput,
  manifest: SynthesisManifest,
): void {
  // -- Cardinality + §13 clean-forbidden rule --------------------------------
  if (draft.result === "clean" && draft.findings.length > 0) {
    throw invalidOutput('result "clean" requires an empty findings array');
  }
  if (draft.result === "findings" && draft.findings.length === 0) {
    throw invalidOutput('result "findings" requires at least one finding');
  }
  if (draft.result === "clean" && manifest.unresolvedFindings.length > 0) {
    throw invalidOutput(
      `the manifest declares ${manifest.unresolvedFindings.length} unresolved finding(s); a clean report is forbidden — semantic validation must not erase a synthesis-declared unresolved finding`,
      { unresolvedFindings: manifest.unresolvedFindings.length },
    );
  }

  // -- Exact scope resolution against the frozen input (§23) ------------------
  for (const [index, finding] of draft.findings.entries()) {
    const what = `findings[${index}]`;
    if (finding.scope.architecture && finding.scope.architecture.revision !== input.architecture.revision) {
      throw invalidOutput(
        `${what} scope cites ARCH@${finding.scope.architecture.revision}, but the current input binds ARCH@${input.architecture.revision}`,
        { index },
      );
    }
    for (const section of finding.scope.sections ?? []) {
      const bound = input.sections.some((s) => s.ref.id === section.id && s.ref.revision === section.revision);
      if (!bound) {
        throw invalidOutput(
          `${what} scope cites ${section.id}@${section.revision}, which is not a SectionRevision of the current SynthesisInput`,
          { index, section: `${section.id}@${section.revision}` },
        );
      }
    }
    if (!finding.scope.architecture && (finding.scope.sections ?? []).length === 0) {
      throw invalidOutput(`${what} must identify an affected scope (architecture and/or section)`);
    }

    // -- Closed manifest-item locators (§21/§23: "manifest item exists") ------
    if (finding.manifestItem) {
      const item = finding.manifestItem;
      switch (item.kind) {
        case "cross_section_link":
          if (item.index < 1 || item.index > manifest.crossSectionLinks.length) {
            throw invalidOutput(`${what} manifestItem cross_section_link[${item.index}] does not exist (manifest has ${manifest.crossSectionLinks.length})`);
          }
          break;
        case "implementation_step":
          if (!manifest.implementationOrder.some((step) => step.order === item.order)) {
            throw invalidOutput(`${what} manifestItem implementation_step[order=${item.order}] does not exist`);
          }
          break;
        case "limitation":
          if (item.index < 1 || item.index > manifest.limitations.length) {
            throw invalidOutput(`${what} manifestItem limitation[${item.index}] does not exist (manifest has ${manifest.limitations.length})`);
          }
          break;
        case "synthesis_finding":
          if (item.index < 1 || item.index > manifest.unresolvedFindings.length) {
            throw invalidOutput(`${what} manifestItem synthesis_finding[${item.index}] does not exist (manifest has ${manifest.unresolvedFindings.length})`);
          }
          break;
      }
    }

    // -- Sources resolve exactly against the frozen input (§22/§23) -----------
    for (const [sourceIndex, source] of (finding.sources ?? []).entries()) {
      if (!sourceRefResolves(source, input, undefined)) {
        throw invalidOutput(
          `${what} cites a source outside the frozen SynthesisInput authority set: ${JSON.stringify(source)}`,
          { index, sourceIndex },
        );
      }
    }
  }
}
