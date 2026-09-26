/**
 * Section workflow vocabulary and transition matrix (Phase 11 directive §4/§7).
 *
 * Workflow state is OPERATIONAL state, deliberately separate from the
 * immutable SectionRevision design content (§2): a workflow transition never
 * rewrites a revision, and a revision never carries a status field.
 *
 * States are frozen (§4) — no done/valid/approved/working/stale synonyms:
 *   open         not yet completed, or explicitly reopened
 *   completed    the EXACT bound Section revision passed a formal
 *                section_completion Proposal → Approval → PlanCommit
 *   needs_review a former completion whose authoritative basis (an upstream
 *                dependency or critical Evidence) has changed; the exact
 *                prior completion provenance is retained until an explicit
 *                reopen clears it
 *
 * There is no terminal state: a needs_review Section can be formally
 * re-completed (§44), and even a completed one can be reopened through an
 * explicit REOPEN_SECTION Proposal change (§39).
 */

export const SECTION_WORKFLOW_STATES = ["open", "completed", "needs_review"] as const;

export type SectionWorkflowState = (typeof SECTION_WORKFLOW_STATES)[number];

/**
 * Append-only workflow event vocabulary (§7). Deliberately absent:
 * SET_STATUS / FORCE_COMPLETE / FORCE_VALID — states are only ever derived
 * from named workflow facts, never set directly.
 */
export const SECTION_WORKFLOW_EVENT_TYPES = [
  "REGISTERED",
  "COMPLETED",
  "REOPENED",
  "DEPENDENCY_REVIEW_REQUIRED",
  "EVIDENCE_REVIEW_REQUIRED",
] as const;

export type SectionWorkflowEventType = (typeof SECTION_WORKFLOW_EVENT_TYPES)[number];

export function isSectionWorkflowState(value: string): value is SectionWorkflowState {
  return (SECTION_WORKFLOW_STATES as readonly string[]).includes(value);
}

export function isSectionWorkflowEventType(value: string): value is SectionWorkflowEventType {
  return (SECTION_WORKFLOW_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * The frozen transition matrix. REGISTERED is the only event allowed a null
 * from-state (creation); every other event must name the materialized state
 * it transitions away from — a mismatch is store corruption, never silently
 * repaired.
 */
const SECTION_WORKFLOW_TRANSITIONS: Readonly<
  Record<SectionWorkflowEventType, readonly SectionWorkflowState[]>
> = {
  REGISTERED: [],
  COMPLETED: ["open", "needs_review"],
  REOPENED: ["completed", "needs_review"],
  DEPENDENCY_REVIEW_REQUIRED: ["completed"],
  EVIDENCE_REVIEW_REQUIRED: ["completed"],
};

/** Whether `event` may legally transition a Section currently in `from`. */
export function isSectionWorkflowTransitionAllowed(
  event: SectionWorkflowEventType,
  from: SectionWorkflowState | null,
): boolean {
  if (event === "REGISTERED") {
    return from === null;
  }
  if (from === null) {
    return false;
  }
  return SECTION_WORKFLOW_TRANSITIONS[event].includes(from);
}

/** The target state of a workflow event (pure; REGISTERED → open). */
export function sectionWorkflowEventTarget(
  event: SectionWorkflowEventType,
): SectionWorkflowState {
  switch (event) {
    case "REGISTERED":
    case "REOPENED":
      return "open";
    case "COMPLETED":
      return "completed";
    case "DEPENDENCY_REVIEW_REQUIRED":
    case "EVIDENCE_REVIEW_REQUIRED":
      return "needs_review";
  }
}
