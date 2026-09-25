import { describe, expect, it } from "vitest";

import {
  getCapabilities,
  requireRun,
  ULTRA_PLAN_CAPABILITIES,
  type CapabilityContext,
  type UltraPlanCapability,
} from "../src/core/capabilities.js";
import { SectionIDs } from "../src/core/ids.js";
import { isUltraPlanError } from "../src/core/errors.js";
import type { PlanningLifecycle, PlanningRun, PlanningStage } from "../src/core/types.js";

type DetailVariant = "decomposition-needed" | "section-ready-revisionless" | "section-ready-checkpointed";

function syntheticRun(
  lifecycle: PlanningLifecycle,
  stage: PlanningStage,
  detailVariant: DetailVariant = "decomposition-needed",
): PlanningRun {
  const ready = stage === "detail" && detailVariant !== "decomposition-needed";
  return {
    id: "PLAN-000" as PlanningRun["id"],
    sessionID: "ses_synthetic",
    lifecycle,
    stage,
    revision: 0,
    goal: { statement: "" },
    constraints: [],
    sections: ready ? [{ id: SectionIDs.from(1) }] : [],
    decisions: [],
    openQuestions: [],
    conflicts: [],
    ...(ready ? { activeWork: { type: "section" as const, id: SectionIDs.from(1) } } : {}),
    createdAt: "",
    updatedAt: "",
  };
}

/** Active-section capability context per detail variant (Phase 2E1 §20). */
const VARIANT_CONTEXT: Readonly<Record<DetailVariant, CapabilityContext>> = {
  "decomposition-needed": {},
  "section-ready-revisionless": { activeSection: { currentRevision: undefined, approvedRevision: undefined } },
  "section-ready-checkpointed": { activeSection: { currentRevision: 1, approvedRevision: 1 } },
};

const MUTATING: readonly UltraPlanCapability[] = [
  "record_question",
  "propose_question_resolution",
  "raise_conflict",
  "promote_evidence",
  "prepare_proposal",
  "prepare_decomposition",
  "prepare_section_checkpoint",
  "request_section_focus",
  "request_reopen",
  "request_completion",
  "request_synthesis",
  "begin_synthesis",
  "submit_synthesis_manifest",
  "run_semantic_validation",
];

const DISCOVERY: UltraPlanCapability[] = [
  "start_or_resume",
  "read_status",
  "read_memory",
  "record_question",
  "propose_question_resolution",
  "promote_evidence",
  "request_architecture",
];
const ARCHITECTURE: UltraPlanCapability[] = [
  ...DISCOVERY.filter((capability) => capability !== "request_architecture"),
  "raise_conflict",
  "prepare_proposal",
  "request_completion",
  "request_user_approval",
];
// Phase 2D §22 + Phase 2E1 §20 + Phase 2E2 §48: detail has THREE STRUCTURED
// SUBSTATES, not a new stage. Focus switching is sanctioned in both
// section-ready substates; request_completion is restored ONLY in the
// checkpointed substate (a revisionless Section has no checkpoint to
// complete); reopen of completed Sections stays withheld everywhere.
const DETAIL_DECOMPOSITION_NEEDED: UltraPlanCapability[] = [
  ...ARCHITECTURE.filter((capability) => capability !== "request_completion"),
  "prepare_decomposition",
];
const DETAIL_SECTION_REVISIONLESS: UltraPlanCapability[] = [
  ...ARCHITECTURE.filter((capability) => capability !== "request_completion"),
  "prepare_section_checkpoint",
  "request_section_focus",
  // Phase 2G §49: dependency-review reopen (approved + needs_review targets).
  "request_reopen",
];
const DETAIL_SECTION_CHECKPOINTED: UltraPlanCapability[] = [
  ...DETAIL_SECTION_REVISIONLESS,
  "request_completion",
];
// Phase 2F §43 + Phase 2G §34 + Phase 2H §53: synthesis has SIX structured
// substates. no-input grants begin_synthesis; input-ready adds
// submit_synthesis_manifest; manifest-ready adds run_semantic_validation (the
// model supplies NO report content). A CURRENT report picks findings vs
// clean; validation-findings adds the restored request_reopen;
// validation-clean adds request_finalization (Phase 2H §52 — the model may
// only REQUEST deterministic finalization); a CURRENT candidate demotes the
// surface to the minimal candidate-ready recheck set (2H §53/§54). The old
// provisional request_synthesis shortcut stays withheld everywhere.
const SYNTHESIS_NO_INPUT: UltraPlanCapability[] = [
  "start_or_resume",
  "read_status",
  "read_memory",
  "record_question",
  "propose_question_resolution",
  "raise_conflict",
  "begin_synthesis",
];
const SYNTHESIS_INPUT_READY: UltraPlanCapability[] = [
  ...SYNTHESIS_NO_INPUT,
  "submit_synthesis_manifest",
];
const SYNTHESIS_MANIFEST_READY: UltraPlanCapability[] = [
  ...SYNTHESIS_INPUT_READY,
  "run_semantic_validation",
];
const SYNTHESIS_VALIDATION_FINDINGS: UltraPlanCapability[] = [
  ...SYNTHESIS_MANIFEST_READY,
  "request_reopen",
];
const SYNTHESIS_VALIDATION_CLEAN: UltraPlanCapability[] = [
  ...SYNTHESIS_MANIFEST_READY.filter((capability) => capability !== "request_reopen"),
  // Phase 2H §52: request deterministic finalization in the clean substate.
  "request_finalization",
];
const SYNTHESIS_CANDIDATE_READY: UltraPlanCapability[] = [
  "start_or_resume",
  "read_status",
  "read_memory",
  "record_question",
  "propose_question_resolution",
  "raise_conflict",
  // Phase 2H §54: idempotent retrieval/recheck; Phase 2I §49 adds the
  // dedicated final-plan preparation (the Harness reruns the gate and freezes
  // the exact final_plan Proposal). Still no design mutation, no submission
  // surface, no Final approval, no handoff.
  "request_finalization",
  "prepare_final_plan",
];
// Phase 2I §50/§51: a CURRENT exact final_plan Proposal (ready/awaiting)
// narrowly grants request_user_approval (§22) on top of the candidate-ready
// surface. The controller independently re-verifies the proposal binding
// pre-ask (§57) and the engine reruns the gate at commit (§25/§26).
const SYNTHESIS_FINAL_PROPOSAL: UltraPlanCapability[] = [
  ...SYNTHESIS_CANDIDATE_READY,
  "request_user_approval",
];
const FINAL: UltraPlanCapability[] = ["start_or_resume", "read_status", "read_memory"];

/**
 * The documented protocol matrix
 * (docs/opencode/spec/opencode-ultra-plan-agent-protocol.md §4), as a literal.
 * If this test fails, code and protocol document have diverged — fix BOTH or
 * neither. Detail is pinned in ALL THREE structured substates; synthesis in
 * ALL FIVE (Phase 2F §43 + Phase 2G §34).
 */
const DOCUMENTED_MATRIX: Record<PlanningStage, UltraPlanCapability[]> = {
  discovery: DISCOVERY,
  architecture: ARCHITECTURE,
  detail: DETAIL_SECTION_REVISIONLESS,
  synthesis: SYNTHESIS_NO_INPUT,
  final: FINAL,
};

const DETAIL_VARIANTS: readonly DetailVariant[] = [
  "decomposition-needed",
  "section-ready-revisionless",
  "section-ready-checkpointed",
];

/** Synthesis substate variants (2F §43 + 2G §34 + 2H §53 + 2I §49/§50). */
type SynthesisVariant =
  | "synthesis-no-input"
  | "synthesis-input-ready"
  | "synthesis-manifest-ready"
  | "synthesis-validation-findings"
  | "synthesis-validation-clean"
  | "synthesis-candidate-ready"
  | "synthesis-final-proposal-ready";
const SYNTHESIS_VARIANTS: readonly SynthesisVariant[] = [
  "synthesis-no-input",
  "synthesis-input-ready",
  "synthesis-manifest-ready",
  "synthesis-validation-findings",
  "synthesis-validation-clean",
  "synthesis-candidate-ready",
  "synthesis-final-proposal-ready",
];
const SYNTHESIS_VARIANT_CONTEXT: Readonly<Record<SynthesisVariant, CapabilityContext>> = {
  "synthesis-no-input": {},
  "synthesis-input-ready": { synthesis: { hasInput: true, hasManifest: false } },
  "synthesis-manifest-ready": { synthesis: { hasInput: true, hasManifest: true } },
  "synthesis-validation-findings": {
    synthesis: { hasInput: true, hasManifest: true, report: { result: "findings" } },
  },
  "synthesis-validation-clean": {
    synthesis: { hasInput: true, hasManifest: true, report: { result: "clean" } },
  },
  "synthesis-candidate-ready": {
    synthesis: { hasInput: true, hasManifest: true, report: { result: "clean" }, candidate: { current: true } },
  },
  "synthesis-final-proposal-ready": {
    synthesis: {
      hasInput: true,
      hasManifest: true,
      report: { result: "clean" },
      candidate: { current: true },
      finalProposal: { status: "ready", current: true },
    },
  },
};
const SYNTHESIS_EXPECTED: Readonly<Record<SynthesisVariant, UltraPlanCapability[]>> = {
  "synthesis-no-input": SYNTHESIS_NO_INPUT,
  "synthesis-input-ready": SYNTHESIS_INPUT_READY,
  "synthesis-manifest-ready": SYNTHESIS_MANIFEST_READY,
  "synthesis-validation-findings": SYNTHESIS_VALIDATION_FINDINGS,
  "synthesis-validation-clean": SYNTHESIS_VALIDATION_CLEAN,
  "synthesis-candidate-ready": SYNTHESIS_CANDIDATE_READY,
  "synthesis-final-proposal-ready": SYNTHESIS_FINAL_PROPOSAL,
};

describe("capability matrix", () => {
  it("grants exactly the documented capability set in every active stage", () => {
    for (const stage of Object.keys(DOCUMENTED_MATRIX) as PlanningStage[]) {
      if (stage === "detail") {
        expect(
          [...getCapabilities(syntheticRun("active", "detail", "decomposition-needed"))].sort(),
          "detail/decomposition-needed",
        ).toEqual(DETAIL_DECOMPOSITION_NEEDED.slice().sort());
        expect(
          [...getCapabilities(syntheticRun("active", "detail", "section-ready-revisionless"), VARIANT_CONTEXT["section-ready-revisionless"])].sort(),
          "detail/section-ready (revisionless active section)",
        ).toEqual(DETAIL_SECTION_REVISIONLESS.slice().sort());
        expect(
          [...getCapabilities(syntheticRun("active", "detail", "section-ready-checkpointed"), VARIANT_CONTEXT["section-ready-checkpointed"])].sort(),
          "detail/section-ready (checkpointed active section)",
        ).toEqual(DETAIL_SECTION_CHECKPOINTED.slice().sort());
        continue;
      }
      if (stage === "synthesis") {
        // Phase 2F §43 + Phase 2G §34: all five synthesis substates.
        for (const variant of SYNTHESIS_VARIANTS) {
          expect(
            [...getCapabilities(syntheticRun("active", "synthesis"), SYNTHESIS_VARIANT_CONTEXT[variant])].sort(),
            `synthesis/${variant}`,
          ).toEqual(SYNTHESIS_EXPECTED[variant].slice().sort());
        }
        continue;
      }
      const capabilities = getCapabilities(syntheticRun("active", stage));
      expect([...capabilities].sort(), `stage=${stage}`).toEqual(
        DOCUMENTED_MATRIX[stage].slice().sort(),
      );
    }
  });

  it("resolves the three detail substates from the active section's revision state (Phase 2E1 §20 + 2E2 §48)", () => {
    // Decomposition-needed until the DAG exists — regardless of context.
    const noDag = getCapabilities(syntheticRun("active", "detail", "decomposition-needed"), {
      activeSection: { currentRevision: 1, approvedRevision: 1 },
    });
    expect(noDag.has("prepare_decomposition")).toBe(true);
    expect(noDag.has("prepare_section_checkpoint")).toBe(false);
    expect(noDag.has("request_section_focus")).toBe(false);
    // Revisionless active section: first-checkpoint surface + focus switching;
    // completion withheld — there is no approved checkpoint to complete.
    const revisionless = getCapabilities(syntheticRun("active", "detail", "section-ready-revisionless"), VARIANT_CONTEXT["section-ready-revisionless"]);
    expect(revisionless.has("prepare_section_checkpoint")).toBe(true);
    expect(revisionless.has("request_section_focus")).toBe(true);
    expect(revisionless.has("prepare_decomposition")).toBe(false);
    expect(revisionless.has("request_completion")).toBe(false);
    // Checkpointed active section: the amend path PLUS restored completion
    // (Phase 2E2 §6) — precise blockers surface instead of a hidden operation.
    const checkpointed = getCapabilities(syntheticRun("active", "detail", "section-ready-checkpointed"), VARIANT_CONTEXT["section-ready-checkpointed"]);
    expect(checkpointed.has("prepare_section_checkpoint")).toBe(true);
    expect(checkpointed.has("request_section_focus")).toBe(true);
    expect(checkpointed.has("request_completion")).toBe(true);
    // Phase 2G §49: dependency-review reopen is granted in the section-ready
    // substates (the controller rejects non-qualifying targets precisely);
    // decomposition-needed still withholds it — no Section exists there.
    expect(noDag.has("request_reopen")).toBe(false);
    expect(revisionless.has("request_reopen")).toBe(true);
    expect(checkpointed.has("request_reopen")).toBe(true);
  });

  it("withholds request_synthesis in reachable synthesis state (Phase 2E2 §30 + 2F §43 + 2G §55)", () => {
    const synthesis = getCapabilities(syntheticRun("active", "synthesis"));
    expect(synthesis.has("request_synthesis")).toBe(false);
    expect(synthesis.has("prepare_proposal")).toBe(false);
    expect(synthesis.has("promote_evidence")).toBe(false);
    // The real synthesis surface: begin + (with input) submit.
    expect(synthesis.has("begin_synthesis")).toBe(true);
    expect(synthesis.has("submit_synthesis_manifest")).toBe(false);
    // Phase 2G: the no-input substate grants neither validation nor reopen.
    expect(synthesis.has("run_semantic_validation")).toBe(false);
    expect(synthesis.has("request_reopen")).toBe(false);
    // Harmless blocker-raising remains available over committed memory.
    expect(synthesis.has("record_question")).toBe(true);
    expect(synthesis.has("raise_conflict")).toBe(true);
  });

  it("exposes no planning mutation capability for completed and aborted runs", () => {
    for (const lifecycle of ["completed", "aborted"] as const) {
      const capabilities = getCapabilities(syntheticRun(lifecycle, "final"));
      for (const capability of MUTATING) {
        expect(capabilities.has(capability), `${lifecycle}/${capability}`).toBe(false);
      }
      // Reads remain available for post-run inspection (spec §34).
      expect(capabilities.has("read_status")).toBe(true);
      expect(capabilities.has("read_memory")).toBe(true);
    }
  });

  it("exposes only handoff-safe capabilities during handoff_pending", () => {
    const capabilities = getCapabilities(syntheticRun("handoff_pending", "final"));
    expect([...capabilities].sort()).toEqual(["read_memory", "read_status"]);
    for (const capability of MUTATING) {
      expect(capabilities.has(capability)).toBe(false);
    }
  });

  it("grants only start_or_resume + status reporting when no run exists", () => {
    const capabilities = getCapabilities(undefined);
    expect([...capabilities].sort()).toEqual(["read_status", "start_or_resume"]);
    expect(capabilities.has("read_memory")).toBe(false);
  });

  it("every granted capability is declared; declared-but-withheld capabilities are exactly the documented ones", () => {
    const granted = new Set<UltraPlanCapability>();
    for (const capability of getCapabilities(undefined)) granted.add(capability);
    for (const stage of Object.keys(DOCUMENTED_MATRIX) as PlanningStage[]) {
      for (const variant of DETAIL_VARIANTS) {
        for (const capability of getCapabilities(syntheticRun("active", stage, variant), VARIANT_CONTEXT[variant])) {
          granted.add(capability);
        }
      }
    }
    for (const variant of SYNTHESIS_VARIANTS) {
      for (const capability of getCapabilities(syntheticRun("active", "synthesis"), SYNTHESIS_VARIANT_CONTEXT[variant])) {
        granted.add(capability);
      }
    }
    for (const capability of getCapabilities(syntheticRun("handoff_pending", "final"))) {
      granted.add(capability);
    }
    // No capability is granted without being declared.
    for (const capability of granted) {
      expect(ULTRA_PLAN_CAPABILITIES, capability).toContain(capability);
    }
    // Phase 2E2 §30 + Phase 2G §55: the old provisional synthesis→final gate
    // remains DECLARED but granted NOWHERE — a clean report must never become
    // a finalization shortcut. (request_reopen is granted again since 2G, in
    // the detail section-ready substates and synthesis validation-findings.)
    const withheld: readonly UltraPlanCapability[] = ["request_synthesis"];
    for (const capability of withheld) {
      expect(ULTRA_PLAN_CAPABILITIES, capability).toContain(capability);
      expect(granted.has(capability), `${capability} must be granted nowhere`).toBe(false);
    }
  });
});

describe("lifecycle restrictions", () => {
  it("refuses run-requiring capabilities on completed runs via requireRun", async () => {
    const completed = syntheticRun("completed", "final");
    for (const capability of MUTATING) {
      try {
        requireRun(completed, capability);
        expect.unreachable(`${capability} should have been refused`);
      } catch (error) {
        expect(isUltraPlanError(error) && error.code).toBe("capability_not_available");
      }
    }
  });

  it("refuses run-requiring capabilities when no run exists with no_active_run", () => {
    try {
      requireRun(undefined, "prepare_proposal");
      expect.unreachable("should have been refused");
    } catch (error) {
      expect(isUltraPlanError(error) && error.code).toBe("no_active_run");
    }
  });
});
