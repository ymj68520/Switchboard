/**
 * The deterministic Finalization Gate (Phase 2H brief §18-§29) — the ONE
 * finalization authority. PURE and synchronous: value-in, value-out, zero
 * store access, zero model calls. Callers (controller, tests) resolve the
 * authoritative objects from the store first; the gate classifies.
 *
 * Result buckets are deliberately separate (brief §28 — never conflate):
 * - STALE: the world moved on (HEAD, synthesis identity, validation report,
 *   evidence audit, or any reachable evidence record). Re-resolve from
 *   current state; an old candidate is never rebased. Staleness takes
 *   precedence so a caller is never told to "fix" a state that has already
 *   been superseded.
 * - BLOCKED: semantic deficiencies of the CURRENT state — run shape,
 *   architecture/section approval, live blocking questions/conflicts,
 *   manifest findings, a non-clean validation report, or audit blockers.
 * - PASS: every term verified; the exact FinalizationIdentity is returned
 *   and the FinalPlanCandidate binds exactly it (brief §29: the gate is
 *   re-evaluable from current state at every request — never a persisted
 *   boolean).
 */
import type { Architecture, PlanningRun, Section } from "../core/types.js";
import type { SectionRootSnapshot, Snapshot } from "../memory/snapshots.js";
import type { ArchitectureRef } from "../core/refs.js";
import type { SynthesisInput, SynthesisManifest } from "../synthesis/types.js";
import type { ValidationReport } from "../validation/types.js";
import type {
  EvidenceAuditSnapshot,
  FinalizationBlocker,
  FinalizationBlockerCode,
  FinalizationGateResult,
  FinalizationIdentity,
  FinalizationStaleness,
} from "./types.js";

/** One Section resolved by the caller in canonical DAG order (brief §23). */
export interface ResolvedGateSection {
  /** The canonical-order root bound by the HEAD snapshot. */
  root: SectionRootSnapshot;
  /** The live committed Section root, when it still exists. */
  live: Section | undefined;
  /** The exact approved SectionRevision record, when it resolves. */
  revision: { approvedRevision: number; record: import("../core/types.js").SectionRevision | undefined };
}

export interface FinalizationGateDeps {
  run: PlanningRun;
  snapshot: Snapshot | undefined;
  architecture: { ref: ArchitectureRef | undefined; record: Architecture | undefined };
  /** Every snapshot section root, canonical DAG order (brief §23). */
  sections: readonly ResolvedGateSection[];
  input: SynthesisInput | undefined;
  /** The newest manifest revision bound to `input`, when any. */
  manifest: SynthesisManifest | undefined;
  /** The caller-resolved current report — the gate re-verifies its binding. */
  report: ValidationReport | undefined;
  /** The caller-resolved audit for the current identity, when any. */
  audit: EvidenceAuditSnapshot | undefined;
  /**
   * The reachable Evidence fingerprint recomputed NOW from the store (brief
   * §26 — mandatory re-check). Undefined only when no HEAD snapshot exists.
   */
  currentEvidenceStateHash: string | undefined;
}

const STALE_CLASS_AUDIT_CODES: readonly string[] = ["synthesis_evidence_stale"];

export function evaluateFinalizationGate(deps: FinalizationGateDeps): FinalizationGateResult {
  const { run, snapshot, architecture, sections, input, manifest, report, audit, currentEvidenceStateHash } = deps;

  // -----------------------------------------------------------------------
  // Staleness phase (brief §28: stale wins — re-resolve before anything else)
  // -----------------------------------------------------------------------
  const stale: FinalizationStaleness[] = [];
  // Identity-drift staleness is only evaluable against a HEAD; with no HEAD
  // at all the head_missing blocker fires instead (no spurious cascade).
  if (snapshot !== undefined) {
    if (input !== undefined && input.baseSnapshot.id !== run.headSnapshot) {
      stale.push({
        code: "synthesis_input_stale",
        detail: `SynthesisInput ${input.id} is anchored to ${input.baseSnapshot.id}; HEAD is ${run.headSnapshot ?? "none"}`,
      });
    }
    if (manifest !== undefined && manifest.baseSnapshot.id !== run.headSnapshot) {
      stale.push({
        code: "manifest_not_current",
        detail: `SynthesisManifest ${manifest.id}@${manifest.revision} is anchored to ${manifest.baseSnapshot.id}; HEAD is ${run.headSnapshot ?? "none"}`,
      });
    }
    if (
      report !== undefined &&
      (report.baseSnapshot.id !== run.headSnapshot ||
        (input !== undefined && report.inputHash !== input.hash) ||
        (manifest !== undefined && report.manifestHash !== manifest.hash))
    ) {
      stale.push({
        code: "validation_report_not_current",
        detail: `ValidationReport ${report.id} is bound to another synthesis identity or another HEAD`,
      });
    }
    if (audit !== undefined) {
      const auditIdentityMoved =
        audit.headSnapshot.id !== run.headSnapshot ||
        (input !== undefined && audit.synthesisInput.hash !== input.hash) ||
        (manifest !== undefined &&
          (audit.synthesisManifest.hash !== manifest.hash || audit.synthesisManifest.revision !== manifest.revision)) ||
        (report !== undefined && audit.validationReport.hash !== report.hash) ||
        (currentEvidenceStateHash !== undefined && audit.evidenceStateHash !== currentEvidenceStateHash);
      if (auditIdentityMoved) {
        stale.push({
          code: "evidence_audit_stale",
          detail: `Evidence audit ${audit.id} is bound to another authoritative state (HEAD/synthesis identity/evidence fingerprint)`,
        });
      }
      if (audit.blockers.some((blocker) => STALE_CLASS_AUDIT_CODES.includes(blocker.code))) {
        stale.push({
          code: "synthesis_evidence_stale",
          detail: audit.blockers
            .filter((blocker) => blocker.code === "synthesis_evidence_stale")
            .map((blocker) => `${blocker.evidence?.id ?? "?"}${blocker.detail ? `: ${blocker.detail}` : ""}`)
            .join("; "),
        });
      }
    }
  }
  if (stale.length > 0) return { result: "stale", stale };

  // -----------------------------------------------------------------------
  // Blocker phase (semantic deficiencies of the CURRENT state, brief §19-§27)
  // -----------------------------------------------------------------------
  const blockers: FinalizationBlocker[] = [];
  if (run.lifecycle !== "active") blockers.push({ code: "lifecycle_not_active" });
  if (run.stage !== "synthesis") blockers.push({ code: "stage_not_synthesis" });
  if (run.activeWork !== undefined) blockers.push({ code: "active_work_present" });
  if (!run.headSnapshot || snapshot === undefined) {
    blockers.push({ code: "head_missing" });
  } else {
    // -- Architecture (brief §22): exact ref, exact record, approved, no latest resolution.
    if (run.architecture === undefined || snapshot.state.architectureRevision === undefined) {
      blockers.push({ code: "architecture_missing" });
    } else if (run.architecture.revision !== snapshot.state.architectureRevision) {
      blockers.push({
        code: "architecture_snapshot_mismatch",
        detail: `run binds ARCH@${run.architecture.revision}; snapshot binds ARCH@${snapshot.state.architectureRevision}`,
      });
    } else if (architecture.record === undefined) {
      blockers.push({
        code: "architecture_missing",
        detail: `ARCH@${snapshot.state.architectureRevision} bound by HEAD does not resolve`,
      });
    } else if (architecture.record.status !== "approved") {
      blockers.push({ code: "architecture_not_approved", detail: `ARCH@${architecture.record.revision} is ${architecture.record.status}` });
    }

    // -- Sections (brief §23): every required Section in canonical DAG order.
    if (sections.length === 0) {
      blockers.push({ code: "sections_missing" });
    }
    for (const section of sections) {
      const id = section.root.id;
      if (section.live === undefined) {
        blockers.push({ code: "section_not_approved", sectionID: id, detail: "Section root bound by HEAD does not exist" });
        continue;
      }
      if (section.live.status !== "approved") {
        blockers.push({ code: "section_not_approved", sectionID: id, detail: `status is ${section.live.status}` });
      }
      if (section.live.validation !== "valid") {
        blockers.push({ code: "section_needs_review", sectionID: id, detail: `validation is ${section.live.validation}` });
      }
      if (
        section.live.currentRevision === undefined ||
        section.live.approvedRevision === undefined ||
        section.live.currentRevision !== section.live.approvedRevision ||
        section.root.approvedRevision !== section.live.approvedRevision ||
        section.revision.approvedRevision !== section.live.approvedRevision
      ) {
        blockers.push({
          code: "section_revision_mismatch",
          sectionID: id,
          detail: `current @${String(section.live.currentRevision)}, approved @${String(section.live.approvedRevision)}, snapshot @${String(section.root.approvedRevision)}, resolved @${section.revision.approvedRevision}`,
        });
        continue;
      }
      if (section.revision.record === undefined) {
        blockers.push({
          code: "section_revision_mismatch",
          sectionID: id,
          detail: `approved revision ${id}@${section.live.approvedRevision} does not resolve`,
        });
        continue;
      }
      const contract = section.revision.record.projection.contract;
      if (contract.sectionID !== id || contract.revision !== section.live.approvedRevision) {
        blockers.push({ code: "section_contract_missing", sectionID: id, detail: `no canonical contract for ${id}@${section.live.approvedRevision}` });
      }
    }

    // -- Synthesis identity (brief §20).
    if (input === undefined) {
      blockers.push({ code: "synthesis_input_missing" });
    } else {
      if (
        manifest === undefined ||
        manifest.input.id !== input.id ||
        manifest.inputHash !== input.hash ||
        manifest.baseSnapshot.id !== input.baseSnapshot.id ||
        manifest.architecture.revision !== input.architecture.revision
      ) {
        blockers.push({ code: "synthesis_manifest_missing" });
      } else {
        // The manifest must mirror the input exactly (§20); sections are the
        // mirror's sharpest edge, so they are compared canonically.
        if (stableSectionsMismatch(manifest.sections, input.sections)) {
          blockers.push({ code: "manifest_input_mismatch", detail: `manifest ${manifest.id}@${manifest.revision} does not mirror input ${input.id}` });
        }
        if (manifest.unresolvedFindings.length > 0) {
          blockers.push({
            code: "manifest_unresolved_findings",
            detail: `manifest ${manifest.id}@${manifest.revision} carries ${manifest.unresolvedFindings.length} unresolved finding(s)`,
          });
        }
      }
      // -- Semantic validation (brief §21): ONE CURRENT clean report.
      if (report === undefined) {
        blockers.push({ code: "validation_not_clean", detail: "no ValidationReport exists for the current synthesis identity" });
      } else if (report.result !== "clean") {
        blockers.push({ code: "validation_not_clean", detail: `ValidationReport ${report.id} result is ${report.result}` });
      }
      // -- Evidence audit (brief §26): current, pass, identity-bound.
      if (audit === undefined) {
        blockers.push({ code: "evidence_audit_missing", detail: "request_finalization builds the audit; none exists for the current identity" });
      } else if (audit.result !== "pass") {
        blockers.push({ code: "evidence_audit_blocked", evidenceBlockers: audit.blockers });
      }
    }
  }

  // -- Live blockers (brief §24/§25): CURRENT run state, never the frozen copies.
  const blockingQuestions = run.openQuestions.filter((question) => question.blocking && question.status === "open");
  if (blockingQuestions.length > 0) {
    blockers.push({ code: "blocking_question", questionIDs: blockingQuestions.map((question) => question.id) });
  }
  const blockingConflicts = run.conflicts.filter((conflict) => conflict.severity === "blocking" && conflict.status === "open");
  if (blockingConflicts.length > 0) {
    blockers.push({ code: "blocking_conflict", conflictIDs: blockingConflicts.map((conflict) => conflict.id) });
  }

  if (blockers.length > 0) return { result: "blocked", blockers };

  // -----------------------------------------------------------------------
  // Pass (brief §28/§29): the exact authority identity a candidate binds.
  // -----------------------------------------------------------------------
  if (
    snapshot === undefined ||
    input === undefined ||
    manifest === undefined ||
    report === undefined ||
    audit === undefined ||
    run.architecture === undefined
  ) {
    // Unreachable when no blocker fired; kept total for the type system.
    return {
      result: "blocked",
      blockers: [
        {
          code: "head_missing" as FinalizationBlockerCode,
          detail: "internal: gate passed without a resolved authority set",
        },
      ],
    };
  }
  const identity: FinalizationIdentity = {
    headSnapshot: { id: snapshot.id },
    headCommit: snapshot.commit,
    architecture: run.architecture,
    synthesisInput: { id: input.id, hash: input.hash },
    synthesisManifest: { id: manifest.id, revision: manifest.revision, hash: manifest.hash },
    validationReport: { id: report.id, hash: report.hash },
    evidenceAudit: { id: audit.id, hash: audit.hash },
  };
  return { result: "pass", identity };
}

function stableSectionsMismatch(
  manifestSections: SynthesisManifest["sections"],
  inputSections: SynthesisInput["sections"],
): boolean {
  if (manifestSections.length !== inputSections.length) return true;
  for (let index = 0; index < manifestSections.length; index++) {
    const a = manifestSections[index];
    const b = inputSections[index];
    if (!a || !b) return true;
    if (a.ref.id !== b.ref.id || a.ref.revision !== b.ref.revision || a.title !== b.title) return true;
  }
  return false;
}
