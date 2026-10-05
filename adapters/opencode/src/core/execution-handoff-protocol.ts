/**
 * ExecutionHandoffProtocol — v0.2.0 Phase 7B §5-§7.
 *
 * The DURABLE handoff-protocol discriminator. Every PlanningRun that reaches
 * the Final Approval transaction records, IN THE SAME ATOMIC PUBLICATION as
 * `lifecycle → handoff_pending` (memory/store.ts commitTransaction), which
 * execution protocol its handoff belongs to:
 *
 *   - "supervised_v0_2" — the approved FinalPlan hands off to a durable
 *     supervised ExecutionRun (prepare → attach SupervisorBinding → activate →
 *     PlanningRun.completed → ExecutionOrchestrator). The legacy free-Build
 *     delivery path is UNREACHABLE for such runs (the store refuses to create
 *     ExecutionHandoff/HandoffDelivery artifacts for them).
 *   - "legacy_v0_1"     — the pre-cutover free-Build delivery (HANDOFF-### +
 *     HandoffDelivery + host-native Build agent prompt). Recovery-only: NO new
 *     Final Approval may create it.
 *
 * The discriminator is NEVER inferred from artifact existence (§5): the legal
 * crash window "Final Approval committed + handoff_pending but the
 * ExecutionRun not yet prepared" must still resolve to supervised_v0_2, which
 * only the run-header marker can prove. Absence of the marker on a durable
 * run means the document predates the cutover → legacy_v0_1 (§7).
 */
import { UltraPlanError } from "./errors.js";
import type { ExecutionRunID, FinalPlanID } from "./ids.js";

export const EXECUTION_HANDOFF_PROTOCOLS = ["legacy_v0_1", "supervised_v0_2"] as const;
export type ExecutionHandoffProtocol = (typeof EXECUTION_HANDOFF_PROTOCOLS)[number];

export function assertExecutionHandoffProtocol(value: string): asserts value is ExecutionHandoffProtocol {
  if (!(EXECUTION_HANDOFF_PROTOCOLS as readonly string[]).includes(value)) {
    throw new UltraPlanError("invalid_scope", `"${value}" is not an execution handoff protocol`, {
      value,
      known: EXECUTION_HANDOFF_PROTOCOLS,
    });
  }
}

/**
 * The resolved protocol of a durable PlanningRun. `handoffProtocol` absent on
 * a stored run is pre-cutover history — exactly the legacy_v0_1 semantics (§7);
 * no NEW run may ever rely on that absence (the Final Approval transaction
 * always records the marker explicitly).
 */
export function planningRunHandoffProtocol(
  run: Pick<import("./types.js").PlanningRun, "handoffProtocol">,
): ExecutionHandoffProtocol {
  return run.handoffProtocol ?? "legacy_v0_1";
}

/**
 * §42 — the minimal exact-ref provenance a REPLAN-originated PlanningRun
 * carries. Execution facts enter the new planning run as EVIDENCE/CONTEXT
 * only (§45): these refs point at canonical execution records, they never
 * promote execution state into Plan Memory.
 */
export interface ReplanProvenance {
  sourceExecutionIssue: { id: import("./ids.js").ExecutionIssueID; executionRunID: ExecutionRunID; hash: string };
  priorFinalPlan: { id: FinalPlanID; revision: number; hash: string };
  priorExecutionRun: ExecutionRunID;
}
