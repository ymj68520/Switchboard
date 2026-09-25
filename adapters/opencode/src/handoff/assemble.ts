/**
 * Deterministic ExecutionHandoff assembly + Build-facing payload rendering
 * (Phase 2J brief §8-§14/§25/§26/§54/§55).
 *
 * NO MODEL CALL anywhere (§8): the handoff is a pure projection of the
 * approved immutable FinalPlan + PlanningRun.goal + exact referenced Plan
 * Memory. The FinalPlan is the execution authority (§9): if the projection
 * and the plan ever disagree, the plan wins, and Build retrieves deeper exact
 * detail through READ-ONLY Plan Memory.
 */
import type { PlanID } from "../core/ids.js";
import { HandoffIDs } from "../core/ids.js";
import type { FinalPlan, PlanningRun, SectionContract } from "../core/types.js";
import { computeExecutionHandoffHash, type ExecutionHandoffHashPayload } from "./hash.js";
import { handoffDeliveryKey, handoffMarkerLines, type ExecutionHandoff } from "./types.js";

export interface AssembleHandoffDeps {
  run: PlanningRun;
  finalPlan: FinalPlan;
  /**
   * The exact canonical SectionContract for every approved SectionRevision in
   * the FinalPlan, resolved by the CALLER from committed Plan Memory (§11):
   * one per revision, deduplicated, canonical order — never regenerated.
   */
  requiredContracts: SectionContract[];
  assign: { id: string; now: import("../core/refs.js").Timestamp };
}

/**
 * §14 closed validation-requirement set: ONLY obligations implied by approved
 * artifacts. No invented test commands, no repository procedures.
 */
export const HANDOFF_VALIDATION_REQUIREMENTS: readonly string[] = [
  "The approved FinalPlan is the execution authority; it wins over this handoff projection.",
  "Respect every approved SectionContract (provides/requires/invariants) for the exact revisions listed.",
  "Do not violate any listed hard committed Constraint.",
  "Implement in the approved dependency/implementation-order structure.",
];

export function assembleExecutionHandoff(deps: AssembleHandoffDeps): { handoff: ExecutionHandoff; deliveryKey: string } {
  const { run, finalPlan, requiredContracts, assign } = deps;
  // §17 preconditions: the final commit/snapshot ARE the run HEAD in a
  // handoff_pending run — a missing HEAD is a caller contract violation.
  if (!run.headCommit || !run.headSnapshot) {
    throw new Error("handoff freeze requires the final PlanCommit/Snapshot at HEAD");
  }
  const id = HandoffIDs.cast(assign.id);
  const payload: ExecutionHandoffHashPayload = {
    planID: finalPlan.planID,
    sessionID: run.sessionID,
    finalPlan: { id: finalPlan.id, revision: finalPlan.revision },
    finalPlanHash: finalPlan.hash,
    finalCommit: run.headCommit,
    finalSnapshot: { id: run.headSnapshot },
    goal: run.goal.statement,
    architecture: { ...finalPlan.architecture },
    sections: finalPlan.sections.map((section) => ({ ...section })),
    // §13 "critical constraints": the exact hard+active committed constraints.
    hardConstraints: finalPlan.constraints.filter((constraint) => constraint.severity === "hard" && constraint.status === "active").map((constraint) => ({ ...constraint })),
    implementationSteps: finalPlan.implementationOrder.map((step) => ({ ...step })),
    requiredContracts: requiredContracts.map((contract) => ({ ...contract })),
    // §12 documented rule: ALL FinalPlan decision refs (no "critical" marker exists).
    criticalDecisions: finalPlan.decisions.map((decision) => ({ ...decision })),
    knownLimitations: finalPlan.limitations.map((limitation) => limitation.statement),
    validationRequirements: [...HANDOFF_VALIDATION_REQUIREMENTS],
  };
  const hash = computeExecutionHandoffHash(payload);
  const handoff: ExecutionHandoff = { ...payload, id, createdAt: assign.now, hash };
  return { handoff, deliveryKey: handoffDeliveryKey(finalPlan.planID, id, hash) };
}

/**
 * The §26 deterministic Build-facing payload with the §25 marker block and
 * the §54/§55 execution rules. Pure projection; no planning conversation
 * (§55). The first Build turn continues implementation WITHOUT asking for
 * reapproval (§54 — Final Approval already happened).
 */
export function renderExecutionHandoffPrompt(planID: PlanID, handoff: ExecutionHandoff, deliveryKey: string): string {
  const lines: string[] = [
    ...handoffMarkerLines(planID, handoff, deliveryKey),
    "",
    "ULTRA PLAN EXECUTION HANDOFF",
    "",
    `Handoff: ${handoff.id}`,
    `hash: ${handoff.hash}`,
    "",
    "Final Plan:",
    `${handoff.finalPlan.id}@${handoff.finalPlan.revision}`,
    `hash: ${handoff.finalPlanHash}`,
    "",
    "Goal:",
    handoff.goal,
    "",
    "Approved Architecture:",
    `ARCH@${handoff.architecture.revision}`,
    "",
    "Implementation Order:",
    ...(handoff.implementationSteps.length > 0
      ? handoff.implementationSteps.map((step) => `${step.order}. ${step.title} — ${step.description}`)
      : ["(none)"]),
    "",
    "Required Section Contracts:",
    ...(handoff.requiredContracts.length > 0
      ? handoff.requiredContracts.map((contract) => `  ${contract.sectionID}@${contract.revision}`)
      : ["  (none)"]),
    "",
    "Critical Constraints:",
    ...(handoff.hardConstraints.length > 0
      ? handoff.hardConstraints.map((constraint) => `  [${constraint.severity}] ${constraint.statement}`)
      : ["  (none)"]),
    "",
    "Relevant Decisions:",
    ...(handoff.criticalDecisions.length > 0
      ? handoff.criticalDecisions.map((decision) => `  ${decision.id}@${decision.revision}`)
      : ["  (none)"]),
    "",
    "Known Limitations:",
    ...(handoff.knownLimitations.length > 0 ? handoff.knownLimitations.map((limitation) => `  - ${limitation}`) : ["  (none)"]),
    "",
    "Execution Rules:",
    ...handoff.validationRequirements.map((requirement) => `- ${requirement}`),
    "- Use read-only Plan Memory (plan_memory) for deeper approved detail.",
    "- Do not mutate committed Plan Memory.",
    "- Local implementation choices are allowed only within approved semantics.",
    "- This handoff authorizes executing the approved plan; it does NOT bypass OpenCode sandbox, tool permissions, user approvals, or safety restrictions.",
    "",
    "Continue implementation from the approved Final Plan. Final Approval has already been given — do not ask whether to implement.",
  ];
  return lines.join("\n");
}
