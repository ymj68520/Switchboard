/**
 * FinalPlan canonical payload parsing (Phase 13 §54 canonical; shared by the
 * handoff, ExecutionIssue, successor-baseline, and execution-structure
 * services). Extracted to its own module so application services can parse
 * the approved FinalPlan without importing the handoff service (no cycles).
 */

import type { FinalPlanV1 } from "../core/finalization.js";
import { RuntimeError } from "../runtime/errors.js";

/** The FinalPlan canonical persisted by the Final PlanCommit (Phase 13 §54). */
export function parseFinalPlanCanonical(raw: unknown, runId: string): FinalPlanV1 {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new RuntimeError(
        "HANDOFF_NOT_AUTHORIZED",
        `FinalPlan canonical payload in run '${runId}' is unparsable`,
        { detail: { runId } },
      );
    }
  }
  if (typeof raw !== "object" || raw === null) {
    throw new RuntimeError("HANDOFF_NOT_AUTHORIZED", `FinalPlan canonical payload in run '${runId}' is not an object`, {
      detail: { runId },
    });
  }
  const plan = raw as FinalPlanV1;
  if (plan.version !== 1 || !Array.isArray(plan.sections) || !Array.isArray(plan.decisions) || !Array.isArray(plan.constraints)) {
    throw new RuntimeError("HANDOFF_NOT_AUTHORIZED", `FinalPlan canonical payload in run '${runId}' has an unsupported shape`, {
      detail: { runId },
    });
  }
  return plan;
}
