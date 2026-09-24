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
import { PLANNING_LIFECYCLES, PLANNING_STAGES, type PlanningLifecycle, type PlanningRun, type PlanningStage } from "../core/types.js";

/** Authority classes — what kind of power the tool wields. */
export type ToolAuthority = "read" | "working_state" | "proposal_intent" | "repository_evidence";

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

/** Synthetic run for matrix derivation (never persisted). */
function syntheticRun(lifecycle: PlanningLifecycle, stage: PlanningStage): PlanningRun {
  return {
    id: "PLAN-000" as PlanningRun["id"],
    sessionID: "synthetic",
    lifecycle,
    stage,
    revision: 0,
    goal: { statement: "" },
    constraints: [],
    sections: [],
    decisions: [],
    openQuestions: [],
    conflicts: [],
    createdAt: "",
    updatedAt: "",
  };
}

function stagesWithCapability(capability: UltraPlanCapability, requiresActiveRun: boolean): PlanningStage[] {
  if (!requiresActiveRun) return [...PLANNING_STAGES];
  return PLANNING_STAGES.filter((stage) =>
    getCapabilities(syntheticRun("active", stage)).has(capability),
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
