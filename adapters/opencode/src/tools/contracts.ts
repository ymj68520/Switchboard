/**
 * Ultra Plan tool contract registry — Phase 2A (spec §38 boundary).
 *
 * Every model-visible tool is declared here with its authority class and the
 * capability it maps to. `allowedStages` / `allowedLifecycle` are DERIVED from
 * the authoritative capability matrix (core/capabilities.ts getCapabilities)
 * so the registry cannot drift from enforcement. The derivation is pinned by
 * tests against the matrix published in
 * docs/opencode/spec/opencode-ultra-plan-agent-protocol.md.
 *
 * Invariants held by construction:
 * - no model-visible tool has mutatesCommittedMemory = true;
 * - no model-visible tool can create an Approval or a PlanCommit
 *   (authority classes have no such capability; approve/commit are not tools).
 */
import { getCapabilities, type UltraPlanCapability } from "../core/capabilities.js";
import { SectionIDs } from "../core/ids.js";
import { PLANNING_LIFECYCLES, PLANNING_STAGES, type PlanningLifecycle, type PlanningRun, type PlanningStage } from "../core/types.js";

/**
 * Authority classes — what kind of power the tool wields. Phase 2F adds
 * `derived_artifact`: may create IMMUTABLE DERIVED WORKFLOW ARTIFACTS
 * (SynthesisInput / SynthesisManifest — durable, hashed, auditable) but must
 * NEVER mutate committed Plan Memory (which is why every such tool still
 * carries mutatesCommittedMemory = false, and why creating them requires no
 * Proposal/Approval/PlanCommit and never moves HEAD — brief §4/§5/§49).
 * Deliberately NOT an overload of proposal_intent.
 */
export type ToolAuthority = "read" | "working_state" | "proposal_intent" | "repository_evidence" | "derived_artifact";

export interface ToolContract {
  name: string;
  authority: ToolAuthority;
  /** The capability (matrix row) that gates this tool. Enforced by the controller. */
  capability: UltraPlanCapability;
  /** Derived from getCapabilities for an active run in each stage. */
  allowedStages: readonly PlanningStage[];
  /** Derived from getCapabilities for each lifecycle. */
  allowedLifecycle: readonly PlanningLifecycle[];
  /** True when the tool refuses to act without an active (or resumable) run. */
  requiresActiveRun: boolean;
  /** Always false for model-visible tools — only PlanCommit mutates committed memory. */
  readonly mutatesCommittedMemory: false;
}

/**
 * Synthetic run for matrix derivation (never persisted). Detail has THREE
 * structured substates (Phase 2D §22 + Phase 2E1 §20) and synthesis has THREE
 * (Phase 2F §43), so derivation runs every variant and grants the stage when
 * the capability is available in ANY: the resulting `allowedStages` is the
 * stage-level projection ("where can this capability ever be granted"), while
 * the authoritative per-run gate remains getCapabilities on the REAL run
 * (with store-resolved active-section / synthesis-artifact state).
 */
function syntheticRun(
  lifecycle: PlanningLifecycle,
  stage: PlanningStage,
  variant: StageVariant = "decomposition-needed",
): PlanningRun {
  const sectionReady = stage === "detail" && variant !== "decomposition-needed";
  const synthesis = stage === "synthesis";
  return {
    id: "PLAN-000" as PlanningRun["id"],
    sessionID: "synthetic",
    lifecycle,
    stage,
    revision: 0,
    goal: { statement: "" },
    constraints: [],
    sections: sectionReady || synthesis ? [{ id: SectionIDs.from(1) }] : [],
    decisions: [],
    openQuestions: [],
    conflicts: [],
    ...(sectionReady ? { activeWork: { type: "section" as const, id: SectionIDs.from(1) } } : {}),
    createdAt: "",
    updatedAt: "",
  };
}

type StageVariant =
  | "decomposition-needed"
  | "section-ready-revisionless"
  | "section-ready-checkpointed"
  | "synthesis-no-input"
  | "synthesis-input-ready"
  | "synthesis-manifest-ready"
  | "synthesis-validation-findings"
  | "synthesis-validation-clean"
  | "synthesis-candidate-ready"
  | "synthesis-final-proposal-ready";

/** Stage variants the matrix derivation sweeps (detail + synthesis substates). */
const STAGE_VARIANTS: readonly StageVariant[] = [
  "decomposition-needed",
  "section-ready-revisionless",
  "section-ready-checkpointed",
  "synthesis-no-input",
  "synthesis-input-ready",
  "synthesis-manifest-ready",
  "synthesis-validation-findings",
  "synthesis-validation-clean",
  "synthesis-candidate-ready",
  "synthesis-final-proposal-ready",
];

/** Capability context matching each synthetic variant (Phase 2E1 §20 + 2F §43 + 2G §34 + 2H §53). */
const VARIANT_CONTEXT: Readonly<Record<StageVariant, import("../core/capabilities.js").CapabilityContext>> = {
  "decomposition-needed": {},
  "section-ready-revisionless": { activeSection: { currentRevision: undefined, approvedRevision: undefined } },
  "section-ready-checkpointed": { activeSection: { currentRevision: 1, approvedRevision: 1 } },
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
  // Phase 2I §50: a CURRENT exact final_plan Proposal exists (ready) — the
  // substate that narrowly grants request_user_approval.
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

function stagesWithCapability(capability: UltraPlanCapability, requiresActiveRun: boolean): PlanningStage[] {
  if (!requiresActiveRun) return [...PLANNING_STAGES];
  return PLANNING_STAGES.filter((stage) =>
    STAGE_VARIANTS.some((variant) =>
      getCapabilities(syntheticRun("active", stage, variant), VARIANT_CONTEXT[variant]).has(capability),
    ),
  );
}

function lifecyclesWithCapability(capability: UltraPlanCapability, requiresActiveRun: boolean): PlanningLifecycle[] {
  if (!requiresActiveRun) return [...PLANNING_LIFECYCLES];
  return PLANNING_LIFECYCLES.filter((lifecycle) =>
    getCapabilities(syntheticRun(lifecycle, "final")).has(capability),
  );
}

interface ContractSeed {
  authority: ToolAuthority;
  capability: UltraPlanCapability;
  requiresActiveRun: boolean;
}

const SEEDS: Record<string, ContractSeed> = {
  // Entry point: creates or resumes the session's single active run.
  ultraplan_start: {
    authority: "working_state",
    capability: "start_or_resume",
    requiresActiveRun: false,
  },
  // Deterministic structured status.
  ultraplan_status: { authority: "read", capability: "read_status", requiresActiveRun: false },
  // Read-only Plan Memory access (spec §20).
  plan_memory: { authority: "read", capability: "read_memory", requiresActiveRun: false },
  // Working-state operations.
  ultraplan_record_question: {
    authority: "working_state",
    capability: "record_question",
    requiresActiveRun: true,
  },
  ultraplan_propose_question_resolution: {
    authority: "working_state",
    capability: "propose_question_resolution",
    requiresActiveRun: true,
  },
  ultraplan_raise_conflict: {
    authority: "working_state",
    capability: "raise_conflict",
    requiresActiveRun: true,
  },
  // Repository evidence promotion (requires observation provenance).
  ultraplan_promote_evidence: {
    authority: "repository_evidence",
    capability: "promote_evidence",
    requiresActiveRun: true,
  },
  // Phase 2C: REQUEST the discovery → architecture transition. The model asks;
  // the Harness validates structural readiness and performs the transition.
  ultraplan_request_architecture: {
    authority: "working_state",
    capability: "request_architecture",
    requiresActiveRun: true,
  },
  // Phase 2D: freeze the COMPLETE initial Section DAG as one atomic proposal.
  // Initial-only: the capability exists solely in the detail
  // decomposition-needed substate and is withheld once the DAG is committed.
  ultraplan_prepare_section_decomposition: {
    authority: "proposal_intent",
    capability: "prepare_decomposition",
    requiresActiveRun: true,
  },
  // Phase 2E1: freeze the ACTIVE section's detailed design into the next
  // exact SectionRevision checkpoint. Target is always run.activeWork; the
  // first checkpoint of a revision-less root freezes add_section_revision,
  // later checkpoints freeze amend_section at the exact prior revision.
  ultraplan_prepare_section_checkpoint: {
    authority: "proposal_intent",
    capability: "prepare_section_checkpoint",
    requiresActiveRun: true,
  },
  // Phase 2E2: sanctioned workflow-focus REQUEST — the model names a target,
  // the Harness validates deterministically and performs the durable
  // transition (expected-focus protected; never a Proposal, never user
  // approval, never set_active_work).
  ultraplan_request_section_focus: {
    authority: "working_state",
    capability: "request_section_focus",
    requiresActiveRun: true,
  },
  // Proposal intent (Harness assigns ids, binds scope/base, freezes + hashes).
  ultraplan_prepare_proposal: {
    authority: "proposal_intent",
    capability: "prepare_proposal",
    requiresActiveRun: true,
  },
  ultraplan_request_completion: {
    authority: "proposal_intent",
    capability: "request_completion",
    requiresActiveRun: true,
  },
  // Approval PRESENTATION request (Phase 2B1 §25): asks the user to approve —
  // it can never approve anything itself. actor="user" comes only from the
  // verified ToolContext.ask interaction.
  ultraplan_request_user_approval: {
    authority: "proposal_intent",
    capability: "request_user_approval",
    requiresActiveRun: true,
  },
  ultraplan_request_reopen: {
    authority: "proposal_intent",
    capability: "request_reopen",
    requiresActiveRun: true,
  },
  ultraplan_request_synthesis: {
    authority: "proposal_intent",
    capability: "request_synthesis",
    requiresActiveRun: true,
  },
  // Phase 2F: freeze the HEAD-anchored SynthesisInput (derived_artifact —
  // creates an immutable derived workflow artifact; never mutates committed
  // Plan Memory, never moves HEAD, requires no approval). The tool accepts NO
  // authoritative refs: the Harness resolves everything from the exact HEAD
  // Snapshot, and a repeated freeze at the same HEAD returns the same input.
  ultraplan_begin_synthesis: {
    authority: "derived_artifact",
    capability: "begin_synthesis",
    requiresActiveRun: true,
  },
  // Phase 2F: submit the derived synthesis output (cross-section links,
  // implementation order, limitations, findings) as the next immutable
  // SynthesisManifest revision. The model supplies ONLY derived content —
  // identity/revision/input binding/refs/hash are Harness-assigned; every
  // statement must cite exact sources inside the frozen input.
  ultraplan_submit_synthesis_manifest: {
    authority: "derived_artifact",
    capability: "submit_synthesis_manifest",
    requiresActiveRun: true,
  },
  // Phase 2G: REQUEST semantic validation of the exact current
  // (SynthesisInput, SynthesisManifest) pair. Accepts NO authoritative report
  // content — the planning model can never declare itself valid; the Harness
  // resolves the pair, invokes the isolated read-only validator, parses the
  // output strictly, and persists the immutable ValidationReport (derived
  // artifact — never a PlanCommit, never HEAD movement). Idempotent under the
  // anti-laundering rule: the same exact identity returns the existing report.
  ultraplan_run_semantic_validation: {
    authority: "derived_artifact",
    capability: "run_semantic_validation",
    requiresActiveRun: true,
  },
  // Phase 2H: REQUEST deterministic finalization. Accepts NOTHING — no force/
  // skip/ignore flags, no manifest/report/evidence references (brief §4): the
  // Harness resolves the current identity, builds the Evidence Audit, and runs
  // the pure Finalization Gate. blocked/stale return exact machine reasons;
  // pass freezes the immutable FinalPlanCandidate (derived artifact — no
  // PlanCommit, no HEAD movement, no stage change, never PlanningRun.finalPlan,
  // never user authorization).
  ultraplan_request_finalization: {
    authority: "derived_artifact",
    capability: "request_finalization",
    requiresActiveRun: true,
  },
  // Phase 2I: freeze the exact final_plan Proposal from the CURRENT
  // FinalPlanCandidate (proposal_intent). Accepts NOTHING — no candidate/manifest/
  // report refs, no plan content: the Harness reruns the Finalization Gate,
  // requires the current candidate + exact identity, projects the FinalPlan via
  // the shared buildFinalPlanFromCandidate, assigns FINAL-###@n, and freezes
  // the single add_final_plan change. The Proposal is NOT approval and commits
  // nothing; the stage remains synthesis until the Final PlanCommit.
  ultraplan_prepare_final_plan: {
    authority: "proposal_intent",
    capability: "prepare_final_plan",
    requiresActiveRun: true,
  },
};

function buildContract(name: string, seed: ContractSeed): ToolContract {
  return {
    name,
    authority: seed.authority,
    capability: seed.capability,
    allowedStages: stagesWithCapability(seed.capability, seed.requiresActiveRun),
    allowedLifecycle: lifecyclesWithCapability(seed.capability, seed.requiresActiveRun),
    requiresActiveRun: seed.requiresActiveRun,
    mutatesCommittedMemory: false,
  };
}

export const TOOL_CONTRACTS: Readonly<Record<string, ToolContract>> = Object.fromEntries(
  Object.entries(SEEDS).map(([name, seed]) => [name, buildContract(name, seed)]),
);

/** Tools that must never exist as model-visible operations. */
export const FORBIDDEN_TOOL_NAMES = [
  // Phase 2A.1 Correction A: the old resolver could clear blocking questions
  // directly — forbidden as a compatibility path; candidates are recorded by
  // ultraplan_propose_question_resolution instead.
  "ultraplan_resolve_question",
  "ultraplan_approve",
  "ultraplan_commit",
  "ultraplan_force_stage",
  "ultraplan_complete_run",
  "ultraplan_plan_exit",
  "write_memory",
  "update_decision",
  "save_architecture",
  "set_section_status",
  "mark_approved",
  "commit_anything",
  "set_stage",
] as const;
