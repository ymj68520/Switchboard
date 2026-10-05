/**
 * ExecutionWorker port + context assembler — v0.2.0 Phase 4 (directive §39-§44).
 *
 * ONE provider-neutral abstraction for BOTH roles (executor and verifier are
 * roles, not separate protocols; role never decides capability). There is
 * deliberately NO concrete OpenCode dispatch adapter in this phase (§40):
 * the production Supervisor runtime does not exist, so the port exists for
 * the protocol and tests only — never invoked automatically, never wired
 * into the production handoff.
 *
 * The context assembler resolves EXACTLY the Directive's planRefs to exact
 * committed records (never the whole Plan Memory, never "latest"); anything
 * the Directive did not reference stays invisible to the Worker, and missing
 * context surfaces as a blocked Report — never as a widened read.
 */
import { UltraPlanError } from "../core/errors.js";
import type { ExecutionWorkerContext, ResolvedExecutionPlanRef } from "./execution-worker.js";
import type { ExecutionDirective } from "../core/execution-directive.js";
import { intersectCapabilities } from "../core/execution-directive.js";
import type { AcceptedStateRef } from "../core/verification-window.js";
import type { WorkerRole } from "../core/execution-attempt.js";
import type { FinalPlanID, PlanID, ExecutionStageID, VerificationWindowID } from "../core/ids.js";
import type { PlanStore } from "../memory/store.js";

export type { ExecutionWorker, ExecutionWorkerContext, ResolvedExecutionPlanRef } from "./execution-worker.js";
export type { WorkerReportPayload } from "./report-payload.js";

/** Exact-revision inputs the assembler resolves the planRefs against. */
export interface WorkerContextInputs {
  planID: PlanID;
  finalPlan: { id: FinalPlanID; revision: number };
  finalPlanRecord: import("../core/types.js").FinalPlan;
  goal: string;
  executionRunID: import("../core/ids.js").ExecutionRunID;
  stage: { id: ExecutionStageID; title: string; objective: string };
  window: { id: VerificationWindowID; baseAcceptedState: AcceptedStateRef };
  role: WorkerRole;
  trustedCeiling: import("../core/execution-directive.js").ExecutionCapabilityCeiling;
  /** Phase 6A §31 — REQUIRED when the Directive is a conflict resolver. */
  conflictResolutionContext?: import("./execution-worker.js").ConflictResolutionContext;
  /** Phase 6A §46 — REQUIRED when the Directive is a reconciliation inspection. */
  reconciliationContext?: import("./execution-worker.js").ReconciliationInspectionContext;
}

/**
 * Assemble the frozen Worker context for ONE exact Directive. Every planRef
 * resolves at its EXACT revision from committed Plan Memory of the run —
 * an unresolvable ref fails closed (`unknown_reference`) instead of
 * silently widening the context.
 */
export async function assembleExecutionWorkerContext(
  store: Pick<PlanStore, "getSectionRevision" | "getDecision">,
  directive: ExecutionDirective,
  inputs: WorkerContextInputs,
): Promise<ExecutionWorkerContext> {
  const resolved: ResolvedExecutionPlanRef[] = [];
  for (const ref of directive.planRefs) {
    switch (ref.kind) {
      case "final_plan":
        resolved.push({ kind: "final_plan", content: inputs.finalPlanRecord });
        break;
      case "section_revision": {
        const content = await store.getSectionRevision(inputs.planID, { id: ref.id, revision: ref.revision });
        if (!content) {
          throw new UltraPlanError("unknown_reference", `Directive planRef ${ref.id}@${ref.revision} does not resolve in committed Plan Memory`, {
            ref,
          });
        }
        resolved.push({ kind: "section_revision", ref: { id: ref.id, revision: ref.revision }, content });
        break;
      }
      case "decision": {
        const content = await store.getDecision(inputs.planID, { id: ref.id, revision: ref.revision });
        if (!content) {
          throw new UltraPlanError("unknown_reference", `Directive planRef ${ref.id}@${ref.revision} does not resolve in committed Plan Memory`, {
            ref,
          });
        }
        resolved.push({ kind: "decision", ref: { id: ref.id, revision: ref.revision }, content });
        break;
      }
      case "constraint": {
        const content = inputs.finalPlanRecord.constraints.find((constraint) => constraint.id === ref.id);
        if (!content) {
          throw new UltraPlanError("unknown_reference", `Directive planRef constraint ${ref.id} does not resolve in the bound FinalPlan`, { ref });
        }
        resolved.push({ kind: "constraint", id: ref.id, content });
        break;
      }
      case "implementation_step": {
        const content = inputs.finalPlanRecord.implementationOrder.find((step) => step.order === ref.order);
        if (!content) {
          throw new UltraPlanError("unknown_reference", `Directive planRef implementation step ${ref.order} does not resolve in the bound FinalPlan`, { ref });
        }
        resolved.push({ kind: "implementation_step", order: ref.order, content });
        break;
      }
    }
  }
  return {
    directive,
    resolvedPlanRefs: resolved,
    finalPlanIdentity: {
      id: inputs.finalPlanRecord.id,
      revision: inputs.finalPlanRecord.revision,
      hash: inputs.finalPlanRecord.hash,
      goal: inputs.goal,
    },
    runIdentity: { executionRunID: inputs.executionRunID },
    stage: inputs.stage,
    window: inputs.window,
    baseCandidateRevision: directive.baseCandidateRevision,
    // §44: the Worker receives the PRECOMPUTED intersection — trusted host/
    // user ceiling ∩ execution policy ceiling ∩ Directive envelope. The role
    // contributes nothing; the Worker never self-declares capability.
    effectiveCapabilities: intersectCapabilities(directive.capabilityEnvelope, inputs.trustedCeiling),
    role: inputs.role,
    // Phase 6A §31/§46 — purpose-scoped context is REQUIRED for the work the
    // Directive names; a resolver or reconciliation inspection assembled
    // without it fails closed instead of guessing.
    ...(directive.verificationPurpose === "conflict_resolution"
      ? inputs.conflictResolutionContext
        ? { conflictResolutionContext: inputs.conflictResolutionContext }
        : (() => {
            throw new UltraPlanError("invalid_scope", "A conflict-resolution Directive requires conflictResolutionContext in the Worker context inputs", {});
          })()
      : {}),
    ...(directive.reconciliationTargets !== undefined
      ? inputs.reconciliationContext
        ? { reconciliationContext: inputs.reconciliationContext }
        : (() => {
            throw new UltraPlanError("invalid_scope", "A reconciliation inspection Directive requires reconciliationContext in the Worker context inputs", {});
          })()
      : {}),
  };
}
