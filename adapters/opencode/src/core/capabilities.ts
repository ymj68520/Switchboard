/**
 * Capability exposure — the authoritative state → allowed-operations matrix
 * (frozen architecture §14 L5, §35 invariants; formalized in Phase 2A).
 *
 * This module is the SINGLE source of truth for what the planning model may do
 * in a given run state. Tools validate through it (controller.assertToolAuth);
 * they must not carry their own stage rules. The matrix is mirrored in
 * docs/opencode/spec/opencode-ultra-plan-agent-protocol.md and pinned by
 * test/capabilities.test.ts — changing code without updating the protocol
 * document (or vice versa) fails the suite.
 */
import { UltraPlanError } from "./errors.js";
import type { PlanningRun, PlanningStage } from "./types.js";
import { isActiveRun } from "./state-machine.js";

/**
 * Semantic capabilities. Every model-visible tool maps to exactly one; reads
 * are capabilities too so exposure stays explicit.
 */
/**
 * Semantic capabilities. Every model-visible tool maps to exactly one; reads
 * are capabilities too so exposure stays explicit. Since Phase 2A.1
 * (Correction A), question "resolution" is only ever a CANDIDATE the model
 * proposes — the authoritative open → resolved transition belongs to an
 * approved PlanCommit.
 */
export const ULTRA_PLAN_CAPABILITIES = [
  "start_or_resume",
  "read_status",
  "read_memory",
  "record_question",
  "propose_question_resolution",
  "raise_conflict",
  "promote_evidence",
  "request_architecture",
  "prepare_proposal",
  "prepare_decomposition",
  "prepare_section_checkpoint",
  "request_section_focus",
  "request_user_approval",
  "request_reopen",
  "request_completion",
  "begin_synthesis",
  "submit_synthesis_manifest",
  "run_semantic_validation",
  "request_finalization",
  "prepare_final_plan",
  "request_synthesis",
] as const;

export type UltraPlanCapability = (typeof ULTRA_PLAN_CAPABILITIES)[number];

/**
 * Stage-scoped capabilities for an ACTIVE run. Derivation from the frozen
 * workflow (Phase 2C + 2D + 2E1 + 2E2):
 *
 * - discovery: inspect, ask questions, ground evidence, and REQUEST the
 *   discovery → architecture transition. No design exists to conflict about,
 *   so no conflicts/proposals yet.
 * - architecture: + conflicts, architecture proposals/checkpoints, and
 *   architecture-scoped completion requests.
 * - detail: THREE STRUCTURED SUBSTATES (Phase 2D §22 + 2E1 §20 + 2E2 §48 —
 *   derived from run state, not a new persisted stage):
 *     · decomposition-needed (sections empty): + prepare_decomposition;
 *       completion/reopen/checkpoint/focus are withheld — no Section exists.
 *     · section-ready / revisionless active section: +
 *       prepare_section_checkpoint + request_section_focus; completion is
 *       withheld — a revisionless Section has no approved checkpoint to
 *       complete (no meaningful completion exists).
 *     · section-ready / checkpointed active section: the same surface plus
 *       request_completion (RESTORED in Phase 2E2). Exposing the capability
 *       despite possible blockers lets the Harness return precise errors
 *       (dependency_incomplete, section_needs_review, …) instead of making
 *       the operation mysteriously disappear (2E2 §7).
 *     REOPEN of completed Sections was withheld through Phase 2E2; Phase 2G
 *     §49 restores `request_reopen` NARROWLY for the dependency-review loop
 *     (approved + needs_review Sections; still a Proposal → user Approval →
 *     PlanCommit — never a direct status change).
 * - synthesis: REACHABLE with real derived-artifact operations (Phase 2F
 *   §43), extended in Phase 2G §34 into FIVE structured substates and in
 *   Phase 2H §53 into SIX, derived from run + latest artifacts + the CURRENT
 *   validation report + the CURRENT FinalPlanCandidate:
 *     · no-input: + begin_synthesis (freeze the HEAD-anchored SynthesisInput).
 *     · input-ready: + submit_synthesis_manifest (derived output only).
 *     · manifest-ready/unvalidated: the same surface + run_semantic_validation
 *       (the model supplies NO report content; the Harness invokes the
 *       isolated read-only validator itself).
 *     · validation-findings: the sanctioned way back to design —
 *       run_semantic_validation (idempotent retrieval) + request_reopen.
 *       No manifest resubmission cliff and no design mutation (2G §36).
 *     · validation-clean/no-candidate: + request_finalization (Phase 2H §52)
 *       — the model may REQUEST deterministic finalization; the Harness
 *       builds the Evidence Audit and runs the Finalization Gate. A clean
 *       report alone grants NO final authority (2G §35).
 *     · final-candidate-ready: a CURRENT FinalPlanCandidate exists — the
 *       minimal recheck surface (reads + harmless blockers +
 *       request_finalization for idempotent retrieval; Phase 2H §54). The
 *       candidate is NOT user approval and does NOT authorize Build; the
 *       stage stays synthesis (2H §76).
 *   begin_synthesis in unvalidated states stays granted deliberately (2F §17
 *   idempotency + stale-input replacement). request_synthesis (the old
 *   provisional synthesis→final shortcut) stays WITHHELD — the real pipeline
 *   is Manifest → Semantic Validation → Evidence Audit → Finalization Gate →
 *   FinalPlanCandidate, and the synthesis→final edge belongs to the Final
 *   PlanCommit (a later phase), never to this shortcut (2H §55).
 * - final: read-only; final approval is USER authority, handoff is Harness
 *   authority.
 */
const STAGE_CAPABILITIES: Readonly<Record<PlanningStage, readonly UltraPlanCapability[]>> = {
  discovery: ["record_question", "propose_question_resolution", "promote_evidence", "request_architecture"],
  architecture: [
    "record_question",
    "propose_question_resolution",
    "raise_conflict",
    "promote_evidence",
    "prepare_proposal",
    "request_completion",
    "request_user_approval",
  ],
  detail: [], // replaced by the three structured substates below
  synthesis: [], // replaced by the three structured substates below
  final: [],
};

/** synthesis + no frozen input yet: begin the real Synthesis workflow. */
const SYNTHESIS_NO_INPUT: readonly UltraPlanCapability[] = [
  "record_question",
  "propose_question_resolution",
  "raise_conflict",
  "begin_synthesis",
];

/** synthesis + frozen input (no manifest yet): submit derived output. */
const SYNTHESIS_INPUT_READY: readonly UltraPlanCapability[] = [
  "record_question",
  "propose_question_resolution",
  "raise_conflict",
  "begin_synthesis",
  "submit_synthesis_manifest",
];

/**
 * synthesis + at least one manifest revision, NOT yet semantically validated:
 * the 2F submission surface (manifest revisions supported) plus the Phase 2G
 * semantic-validation request — the model supplies NO report content; the
 * Harness invokes the isolated validator itself.
 */
const SYNTHESIS_MANIFEST_READY: readonly UltraPlanCapability[] = [
  ...SYNTHESIS_INPUT_READY,
  "run_semantic_validation",
];

/**
 * synthesis + a CURRENT findings report (Phase 2G §36): the sanctioned way
 * back to design is `request_reopen` (restored narrowly). Manifest
 * REVISIONS remain available deliberately (§66): a genuinely revised manifest
 * creates a NEW validation identity and a NEW judgment — that is the
 * anti-laundering rule's sanctioned alternative to reopening design, and it
 * can never re-roll an existing report. No design mutation exists here.
 */
const SYNTHESIS_VALIDATION_FINDINGS: readonly UltraPlanCapability[] = [
  "record_question",
  "propose_question_resolution",
  "raise_conflict",
  "begin_synthesis",
  "submit_synthesis_manifest",
  "run_semantic_validation",
  "request_reopen",
];

/**
 * synthesis + a CURRENT clean report (Phase 2G §35 + Phase 2H §52): a clean
 * report restores NO design mutation. run_semantic_validation stays exposed
 * for idempotent retrieval of the existing report; Phase 2H adds
 * request_finalization — the model may REQUEST deterministic finalization
 * (Evidence Audit + Finalization Gate), never declare its outcome.
 */
const SYNTHESIS_VALIDATION_CLEAN: readonly UltraPlanCapability[] = [
  "record_question",
  "propose_question_resolution",
  "raise_conflict",
  "begin_synthesis",
  "submit_synthesis_manifest",
  "run_semantic_validation",
  "request_finalization",
];

/**
 * synthesis + a CURRENT FinalPlanCandidate with NO current final Proposal
 * (Phase 2H §53/§54 + Phase 2I §49): the recheck surface plus the dedicated
 * final-plan preparation — the Harness reruns the Finalization Gate and freezes
 * the exact final_plan Proposal (proposal_intent; the model supplies nothing).
 * Deliberately NO design mutation and no request_synthesis (2I §53).
 */
const SYNTHESIS_CANDIDATE_READY: readonly UltraPlanCapability[] = [
  "record_question",
  "propose_question_resolution",
  "raise_conflict",
  "request_finalization",
  "prepare_final_plan",
];

/**
 * synthesis + a CURRENT exact final_plan Proposal, ready or awaiting_approval
 * (Phase 2I §50/§51): `request_user_approval` is granted NARROWLY — the
 * controller independently verifies the proposal is type=final_plan, binds the
 * CURRENT candidate, and still matches the current gate identity before any
 * ask (§20/§22/§57). A stale Final Proposal is refused pre-ask
 * (`final_proposal_stale`), never presented. submit_synthesis_manifest, Section
 * mutation, unsanctioned reopen, and request_synthesis stay withheld.
 */
const SYNTHESIS_FINAL_PROPOSAL: readonly UltraPlanCapability[] = [
  "record_question",
  "propose_question_resolution",
  "raise_conflict",
  "request_finalization",
  "prepare_final_plan",
  "request_user_approval",
];

/** detail + sections=[] + no activeWork: establish the initial Section DAG. */
const DETAIL_DECOMPOSITION_NEEDED: readonly UltraPlanCapability[] = [
  "record_question",
  "propose_question_resolution",
  "raise_conflict",
  "promote_evidence",
  "prepare_proposal",
  "request_user_approval",
  "prepare_decomposition",
];

/**
 * detail + committed DAG, revisionless ACTIVE section (no approved
 * SectionRevision yet): the FIRST checkpoint path plus sanctioned focus
 * switching (discussion may run ahead of dependency completion). Section
 * completion is withheld — there is no approved checkpoint to complete.
 */
const DETAIL_SECTION_REVISIONLESS: readonly UltraPlanCapability[] = [
  "record_question",
  "propose_question_resolution",
  "raise_conflict",
  "promote_evidence",
  "prepare_proposal",
  "request_user_approval",
  "prepare_section_checkpoint",
  "request_section_focus",
  // Phase 2G §49: dependency-review reopen is a DETAIL operation — the model
  // may request reopening an approved, dependency-invalidated Section; the
  // controller rejects targets that do not qualify with precise errors.
  "request_reopen",
];

/**
 * detail + committed DAG, checkpointed ACTIVE section: the amend path plus
 * RESTORED Section completion (Phase 2E2 §6). The capability is exposed even
 * when deterministic blockers exist so the Harness can return precise
 * blocker errors (2E2 §7).
 */
const DETAIL_SECTION_CHECKPOINTED: readonly UltraPlanCapability[] = [
  "record_question",
  "propose_question_resolution",
  "raise_conflict",
  "promote_evidence",
  "prepare_proposal",
  "request_user_approval",
  "prepare_section_checkpoint",
  "request_section_focus",
  "request_completion",
  // Phase 2G §49: dependency-review reopen (see DETAIL_SECTION_REVISIONLESS).
  "request_reopen",
];

/**
 * Lifecycle always-granted capabilities. start_or_resume is how a session with
 * a completed/aborted run begins a NEW run; reads stay available for post-run
 * inspection (spec §34 gives execution read-only Plan Memory access).
 */
const LIFECYCLE_BASE: readonly UltraPlanCapability[] = [
  "start_or_resume",
  "read_status",
  "read_memory",
];

/**
 * handoff_pending is recoverable-handoff territory: planning mutation is
 * closed; recovery/handoff operations are Harness-authoritative (not
 * model-visible tools).
 */
const HANDOFF_CAPABILITIES: readonly UltraPlanCapability[] = ["read_status", "read_memory"];

/**
 * Optional run context the capability resolver needs to distinguish the
 * detail section-ready substates (Phase 2E1 §20 + 2E2 §48) and the synthesis
 * substates (Phase 2F §43 + Phase 2G §34). The run header itself does not
 * carry Section revision, synthesis-artifact, or validation state, so callers
 * with store access pass what they resolved. Omitted fields resolve the COARSE
 * surfaces (revisionless detail / no-input synthesis) — matrix derivation uses
 * explicit variant contexts.
 */
export interface CapabilityContext {
  activeSection?: Pick<import("./types.js").Section, "currentRevision" | "approvedRevision">;
  /**
   * Phase 2F/2G/2H: the synthesis stage's derived-artifact state. `report` is
   * present only when a successful ValidationReport exists for the CURRENT
   * (latest input + its latest manifest) identity; its result picks the
   * validation-findings vs validation-clean substate. `candidate` is present
   * only when a FinalPlanCandidate exists; `current` reports whether it is
   * STILL current (the derivation is computed by callers with store access) —
   * a current candidate picks final-candidate-ready, a stale one falls back
   * to validation-clean (2H §51/§53).
   */
  synthesis?: {
    hasInput: boolean;
    hasManifest: boolean;
    report?: { result: "clean" | "findings" };
    candidate?: { current: boolean };
    /**
     * Phase 2I §50/§51: the current final_plan Proposal, when one exists and
     * binds the CURRENT candidate. `current` is derived by callers with store
     * access (candidate binding + gate identity, never a stored flag); a
     * current ready/awaiting proposal picks the final-proposal substate that
     * narrowly grants request_user_approval (§22).
     */
    finalProposal?: { status: "ready" | "awaiting_approval"; current: boolean };
  };
}

/**
 * The authoritative capability decision function.
 *
 * - No run: start a new one; report the absence (renderNoRunStatus). Anything
 *   that reads or mutates actual memory needs a run.
 * - active: base reads + the stage matrix (detail resolves its structured
 *   substate from sections/activeWork/active-section revision state —
 *   Phase 2D §22 + Phase 2E1 §20).
 * - handoff_pending / completed / aborted: reads only, no planning mutation.
 */
export function getCapabilities(
  run: PlanningRun | undefined,
  context: CapabilityContext = {},
): ReadonlySet<UltraPlanCapability> {
  if (!run) return new Set<UltraPlanCapability>(["start_or_resume", "read_status"]);
  if (run.lifecycle === "handoff_pending") return new Set<UltraPlanCapability>(HANDOFF_CAPABILITIES);
  if (!isActiveRun(run)) return new Set<UltraPlanCapability>(LIFECYCLE_BASE);

  let stageCapabilities: readonly UltraPlanCapability[];
  if (run.stage === "detail") {
    if (run.sections.length === 0) {
      stageCapabilities = DETAIL_DECOMPOSITION_NEEDED;
    } else {
      // Section-ready: the active section's revision state picks the
      // substate. Both grant the same set in Phase 2E1 (protocol matrix
      // v0.5); they are resolved separately so Phase 2E2 can differentiate
      // completion without changing call sites.
      stageCapabilities =
        context.activeSection?.currentRevision !== undefined
          ? DETAIL_SECTION_CHECKPOINTED
          : DETAIL_SECTION_REVISIONLESS;
    }
  } else if (run.stage === "synthesis") {
    // Phase 2F §43 + Phase 2G §34 + Phase 2H §53: SIX structured substates
    // resolved from the latest derived artifacts, the CURRENT validation
    // report, and the CURRENT FinalPlanCandidate (context resolved by callers
    // with store access; absence = no-input). A stale candidate is NOT
    // candidate-ready (2H §51 — staleness is derived, never mutated onto the
    // old candidate).
    const synthesis = context.synthesis;
    stageCapabilities = !synthesis?.hasInput
      ? SYNTHESIS_NO_INPUT
      : !synthesis.hasManifest
        ? SYNTHESIS_INPUT_READY
        : !synthesis.report
          ? SYNTHESIS_MANIFEST_READY
          : synthesis.report.result === "findings"
            ? SYNTHESIS_VALIDATION_FINDINGS
            : synthesis.finalProposal?.current
              ? SYNTHESIS_FINAL_PROPOSAL
              : synthesis.candidate?.current
                ? SYNTHESIS_CANDIDATE_READY
                : SYNTHESIS_VALIDATION_CLEAN;
  } else {
    stageCapabilities = STAGE_CAPABILITIES[run.stage];
  }

  return new Set<UltraPlanCapability>([
    ...LIFECYCLE_BASE,
    ...stageCapabilities,
  ]);
}

/**
 * Capability check + run narrowing for operations that need a run. Throws
 * `no_active_run` when run is undefined, then delegates to assertCapability.
 */
export function requireRun(
  run: PlanningRun | undefined,
  capability: UltraPlanCapability,
  context: CapabilityContext = {},
): PlanningRun {
  if (!run) {
    throw new UltraPlanError(
      "no_active_run",
      `Capability "${capability}" requires an active PlanningRun; invoke /ultra-plan first`,
      { capability },
    );
  }
  assertCapability(run, capability, context);
  return run;
}

/**
 * Deterministic enforcement point for tool invocations. `no_active_run` when
 * the capability needs a run and none exists; `capability_not_available` when
 * the run exists but the current stage/lifecycle does not grant the
 * capability.
 */
export function assertCapability(
  run: PlanningRun | undefined,
  capability: UltraPlanCapability,
  context: CapabilityContext = {},
): void {
  if (getCapabilities(run, context).has(capability)) return;
  if (!run) {
    throw new UltraPlanError(
      "no_active_run",
      `Capability "${capability}" requires an active PlanningRun; invoke /ultra-plan first`,
      { capability },
    );
  }
  throw new UltraPlanError(
    "capability_not_available",
    `Capability "${capability}" is not available in lifecycle=${run.lifecycle}, stage=${run.stage}`,
    { capability, stage: run.stage, lifecycle: run.lifecycle },
  );
}
