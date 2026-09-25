/**
 * Phase 2J — the recoverable ExecutionHandoff and its delivery workflow state.
 *
 * TWO DELIBERATELY SEPARATE CONCEPTS (brief §19/§20):
 *
 * 1. `ExecutionHandoff` (HANDOFF-###) — an IMMUTABLE DERIVED WORKFLOW ARTIFACT
 *    (the same authority family as SynthesisInput/ValidationReport/
 *    FinalPlanCandidate, §6): deterministically projected from the approved
 *    immutable FinalPlan + the run goal + exact referenced Plan Memory (§8).
 *    Creating it moves no HEAD, mutates no FinalPlan, and is NOT a Proposal/
 *    Approval/PlanCommit. ONE approved FinalPlan corresponds to exactly ONE
 *    canonical handoff (§16) — recovery reuses HANDOFF-001 forever; the
 *    handoff is NEVER rewritten after delivery (§50).
 *
 * 2. `HandoffDelivery` — the mutable WORKFLOW/HOST-SIDE-EFFECT record
 *    (prepared → dispatching → delivered). Retry counters, attempts, and the
 *    host receipt live HERE, never on the immutable handoff (§20). The
 *    delivery is an outbox-like durable intent: `prepared` exists BEFORE the
 *    first host dispatch (§38), and `delivered` means the exact handoff
 *    message was OBSERVED in the target session's host history under the
 *    intended execution runtime context (§23) — never merely "the request
 *    returned 200".
 *
 * Runtime identity (§27/§28) is trusted state: the delivery targets exactly
 * `PlanningRun.sessionID`, and agent/model come from adapter configuration —
 * never from model-supplied arguments.
 */
import type { CommitID, HandoffID, PlanID } from "../core/ids.js";
import type {
  ArchitectureRef,
  DecisionRef,
  SectionRevisionRef,
  SnapshotRef,
  Timestamp,
} from "../core/refs.js";
import type { Constraint, SectionContract } from "../core/types.js";
import type { ImplementationStep } from "../synthesis/types.js";

/**
 * The immutable execution-facing projection of the approved FinalPlan
 * (brief §7, adapted to the real domain — constraints/contracts are embedded
 * exactly because they ARE the approved content; no new normative facts).
 */
export interface ExecutionHandoff {
  id: HandoffID;
  planID: PlanID;
  /** Trusted runtime identity — exactly PlanningRun.sessionID (§27). */
  sessionID: string;

  finalPlan: { id: import("../core/ids.js").FinalPlanID; revision: number };
  finalPlanHash: string;

  finalCommit: CommitID;
  finalSnapshot: SnapshotRef;

  goal: string;

  architecture: ArchitectureRef;
  /** Exact approved SectionRevisions, canonical order (§10 — never "latest"). */
  sections: SectionRevisionRef[];
  /** Exact committed hard+active constraints (§13 "critical constraints"). */
  hardConstraints: Constraint[];
  /** EXACT copy of the FinalPlan implementation order (§8 — never regenerated). */
  implementationSteps: ImplementationStep[];
  /**
   * One EXACT canonical contract per exact approved SectionRevision in the
   * FinalPlan, deduplicated, canonical order (§11 — resolved from committed
   * Plan Memory, never regenerated).
   */
  requiredContracts: SectionContract[];
  /**
   * §12 documented deterministic rule: ALL FinalPlan DecisionRefs. The domain
   * has no "critical" marker, so the precise rule is used verbatim rather
   * than any heuristic classifier or model judgment.
   */
  criticalDecisions: DecisionRef[];
  /** Exact validated FinalPlan limitation statements (§13 — never dropped). */
  knownLimitations: string[];
  /**
   * §14: only deterministic requirements implied by approved artifacts — a
   * closed set of structural obligations (see assembleExecutionHandoff).
   */
  validationRequirements: string[];

  createdAt: Timestamp;
  /** Canonical hash over the semantic payload (§15) — excludes id/createdAt/hash. */
  hash: string;
}

/** The delivery workflow record's closed state set (brief §19). */
export type HandoffDeliveryState = "prepared" | "dispatching" | "delivered";

/**
 * Receipt built ONLY from identifiers actually returned/observable from the
 * host (§22/§112): the target session, the exact delivered user message id,
 * and the host-exposed execution agent/model of that message. No credentials,
 * no opaque provider internals.
 */
export interface HostDeliveryReceipt {
  sessionID: string;
  messageID: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
}

export interface HandoffDelivery {
  planID: PlanID;
  handoffID: HandoffID;
  handoffHash: string;
  /** Exactly PlanningRun.sessionID (§27) — never a model/tool-supplied id. */
  sessionID: string;

  state: HandoffDeliveryState;

  /** Number of dispatch admissions begun (1 after the first CAS). */
  attempt: number;

  /**
   * §21: stable correlation identity derived from exact handoff identity:
   * `<planID>/<handoffID>/<handoffHash>`. Embedded in the handoff marker and
   * used as the host history-lookup key.
   */
  deliveryKey: string;

  /** Present ONLY in the delivered state (§87 — never on prepared). */
  hostReceipt?: HostDeliveryReceipt;

  preparedAt: Timestamp;
  dispatchStartedAt?: Timestamp;
  deliveredAt?: Timestamp;
}

/**
 * §21: the stable delivery key derived from exact handoff identity. Also the
 * unique machine-searchable correlation line inside the delivered prompt
 * (§25): `delivery-key=<deliveryKey>`.
 */
export function handoffDeliveryKey(planID: PlanID, handoffID: HandoffID, handoffHash: string): string {
  return `${planID}/${handoffID}/${handoffHash}`;
}

/** The §25 stable machine-readable marker line set embedded in the payload. */
export function handoffMarkerLines(planID: PlanID, handoff: Pick<ExecutionHandoff, "id" | "hash" | "finalPlan">, deliveryKey: string): string[] {
  return [
    "ULTRA_PLAN_HANDOFF",
    `plan=${planID}`,
    `handoff=${handoff.id}`,
    `hash=${handoff.hash}`,
    `finalPlan=${handoff.finalPlan.id}@${handoff.finalPlan.revision}`,
    `delivery-key=${deliveryKey}`,
  ];
}
